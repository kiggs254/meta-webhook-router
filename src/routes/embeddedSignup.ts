import { Router, type Request, type Response } from 'express';
import { config } from '../config/index.js';
import { Tenant } from '../models/index.js';
import logger from '../utils/logger.js';

const router = Router();

function isValidParentOrigin(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    if (config.server.env === 'development' && u.protocol === 'http:') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * GET /embedded-signup/start
 *
 * Serves a tiny HTML page that loads the Facebook JS SDK on the router's
 * already-whitelisted domain, runs FB.login for WhatsApp Embedded Signup,
 * captures the resulting `code` plus the WA_EMBEDDED_SIGNUP postMessage
 * payload from Meta, then relays everything back to the Shopflow install
 * that opened the popup via window.opener.postMessage.
 *
 * Query params:
 *   tenant_id      — must exist in the tenants table and be enabled
 *   state          — opaque CSRF nonce echoed back in the postMessage
 *   parent_origin  — the Shopflow admin origin that opened the popup;
 *                    used as the postMessage targetOrigin
 *
 * The router never sees the auth code — it lives only in the browser. The
 * Shopflow install exchanges it server-side using its own META_APP_SECRET,
 * just like a non-proxy run.
 */
router.get('/start', async (req: Request, res: Response) => {
  try {
    if (!config.meta.appId || !config.meta.embeddedSignupConfigId) {
      res.status(503).type('text/plain').send(
        'Embedded-signup proxy is not configured on this router. ' +
          'Set META_APP_ID and META_EMBEDDED_SIGNUP_CONFIG_ID.'
      );
      return;
    }

    const tenantId = String(req.query.tenant_id || '').trim();
    const state = String(req.query.state || '').trim();
    const parentOrigin = String(req.query.parent_origin || '').trim();

    if (!tenantId || !state || !parentOrigin) {
      res.status(400).type('text/plain').send('tenant_id, state, and parent_origin are required');
      return;
    }
    if (state.length < 16 || state.length > 128) {
      res.status(400).type('text/plain').send('state must be 16-128 chars');
      return;
    }
    if (!isValidParentOrigin(parentOrigin)) {
      res.status(400).type('text/plain').send('parent_origin must be a valid https origin');
      return;
    }

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant || !tenant.enabled) {
      res.status(404).type('text/plain').send('Unknown or disabled tenant');
      return;
    }

    const inlineConfig = {
      appId: config.meta.appId,
      configId: config.meta.embeddedSignupConfigId,
      solutionId: config.meta.solutionId || null,
      graphVersion: config.meta.graphVersion,
      state,
      parentOrigin,
      tenantId,
    };

    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline' https://connect.facebook.net",
        "connect-src https://graph.facebook.com https://*.facebook.com",
        "frame-src https://*.facebook.com",
        "img-src 'self' data: https://*.facebook.com",
        "style-src 'unsafe-inline'",
        "form-action 'none'",
        "base-uri 'none'",
      ].join('; ')
    );
    res.type('text/html').send(renderHtml(inlineConfig));
  } catch (err) {
    logger.error('[embedded-signup] start failed', err);
    res.status(500).type('text/plain').send('Internal error');
  }
});

interface InlineConfig {
  appId: string;
  configId: string;
  solutionId: string | null;
  graphVersion: string;
  state: string;
  parentOrigin: string;
  tenantId: string;
}

function renderHtml(cfg: InlineConfig): string {
  // Inline as a JSON <script> tag so the browser script can read it without
  // template interpolation in JS. JSON.stringify is safe for the values we
  // accept (validated above), but we also escape </script> defensively.
  const json = JSON.stringify(cfg).replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Connect WhatsApp</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 32px; background: #f6f7f9; color: #1c1e21; }
    .card { max-width: 520px; margin: 60px auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); padding: 28px; text-align: center; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { font-size: 14px; color: #606770; margin: 0 0 20px; line-height: 1.5; }
    button { background: #1877f2; color: #fff; border: 0; border-radius: 8px; padding: 12px 20px; font-size: 15px; font-weight: 600; cursor: pointer; }
    button[disabled] { opacity: 0.6; cursor: default; }
    .err { color: #b00020; font-size: 13px; margin-top: 16px; min-height: 18px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect WhatsApp Business</h1>
    <p>Click below to continue with Facebook. Meta will guide you through choosing a business and a phone number.</p>
    <button id="go" disabled>Continue with Facebook</button>
    <div class="err" id="err"></div>
  </div>
  <script id="config" type="application/json">${json}</script>
  <script>
  (function(){
    var cfg = JSON.parse(document.getElementById('config').textContent);
    var btn = document.getElementById('go');
    var errEl = document.getElementById('err');
    var posted = false;
    var session = {};

    function showErr(msg) { errEl.textContent = msg || ''; }

    function postBack(payload) {
      if (posted) return;
      posted = true;
      try {
        if (window.opener) {
          window.opener.postMessage(
            Object.assign({ type: 'SHOPFLOW_PROXY_SIGNUP', state: cfg.state, tenant_id: cfg.tenantId }, payload),
            cfg.parentOrigin
          );
        }
      } catch (e) { /* ignore */ }
      // Give the parent a tick to receive the message before the window goes away
      setTimeout(function(){ try { window.close(); } catch (e) {} }, 250);
    }

    if (!window.opener) {
      showErr('This page must be opened from your Shopflow admin — not directly.');
      return;
    }

    // Capture WA_EMBEDDED_SIGNUP messages Meta posts during the popup flow
    window.addEventListener('message', function(event){
      var origin = '';
      try { origin = new URL(event.origin).hostname; } catch (e) { return; }
      if (!/(^|\\.)facebook\\.com$/.test(origin)) return;
      try {
        var data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (!data || data.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (data.event) session.event = String(data.event);
        if (data.data) {
          if (data.data.waba_id) session.waba_id = String(data.data.waba_id);
          if (data.data.phone_number_id) session.phone_number_id = String(data.data.phone_number_id);
          if (data.data.business_id) session.business_id = String(data.data.business_id);
        }
      } catch (e) { /* ignore non-JSON messages */ }
    });

    window.fbAsyncInit = function() {
      window.FB.init({ appId: cfg.appId, cookie: true, xfbml: false, version: cfg.graphVersion });
      btn.disabled = false;
    };

    var s = document.createElement('script');
    s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.onerror = function(){ showErr('Failed to load Facebook SDK.'); };
    document.body.appendChild(s);

    btn.addEventListener('click', function(){
      if (!window.FB) { showErr('Facebook SDK not ready yet.'); return; }
      btn.disabled = true;
      window.FB.login(function(resp){
        var code = resp && resp.authResponse && resp.authResponse.code;
        if (!code) {
          postBack({ error: session.event === 'CANCEL' || !session.event ? 'cancelled' : ('failed:' + session.event) });
          return;
        }
        postBack({
          code: code,
          event: session.event || 'FINISH',
          waba_id: session.waba_id,
          phone_number_id: session.phone_number_id,
          business_id: session.business_id
        });
      }, {
        config_id: cfg.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: cfg.solutionId ? { solutionID: cfg.solutionId } : {},
          featureType: 'whatsapp_business_app_onboarding',
          sessionInfoVersion: '3'
        }
      });
    });
  })();
  </script>
</body>
</html>`;
}

export default router;
