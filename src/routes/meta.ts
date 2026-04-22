import type { Request, Response } from 'express';
import crypto from 'crypto';
import { config } from '../config/index.js';
import { Registration, DeliveryLog, WebhookHit } from '../models/index.js';
import logger from '../utils/logger.js';
import { triggerDispatch } from '../services/fanout.js';

async function recordHit(fields: {
  method: string;
  outcome: string;
  http_status: number;
  waba_ids?: string[] | null;
  entry_count?: number;
  dispatched_count?: number;
  reason?: string | null;
  signature_present?: boolean;
  verify_mode?: string | null;
  body_size?: number;
}): Promise<void> {
  try {
    await WebhookHit.create({
      method: fields.method,
      outcome: fields.outcome,
      http_status: fields.http_status,
      waba_ids: fields.waba_ids ?? null,
      entry_count: fields.entry_count ?? 0,
      dispatched_count: fields.dispatched_count ?? 0,
      reason: fields.reason ?? null,
      signature_present: !!fields.signature_present,
      verify_mode: fields.verify_mode ?? null,
      body_size: fields.body_size ?? 0,
    });
  } catch (err) {
    logger.warn('[webhook] failed to persist hit', err);
  }
}

/**
 * GET /meta/webhooks — Meta subscription verification.
 */
export async function handleMetaVerification(req: Request, res: Response): Promise<void> {
  const mode = String(req.query['hub.mode'] || '');
  const verifyToken = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');

  logger.info(
    `[webhook] GET verify — mode="${mode}", token_present=${!!verifyToken}, challenge_present=${!!challenge}`
  );

  if (mode === 'subscribe' && verifyToken && verifyToken === config.meta.verifyToken) {
    logger.info(`[webhook] verification OK, echoing challenge`);
    await recordHit({
      method: 'GET',
      outcome: 'verified',
      http_status: 200,
      verify_mode: mode,
    });
    res.status(200).type('text/plain').send(challenge);
    return;
  }

  const reason = !verifyToken
    ? 'no verify token in query'
    : verifyToken !== config.meta.verifyToken
    ? 'verify token mismatch — check META_WEBHOOK_VERIFY_TOKEN env var'
    : `mode was "${mode}", expected "subscribe"`;
  logger.warn(`[webhook] verification FAILED: ${reason}`);
  await recordHit({
    method: 'GET',
    outcome: 'verify_failed',
    http_status: 403,
    reason,
    verify_mode: mode,
  });
  res.status(403).send('Forbidden');
}

/**
 * POST /meta/webhooks — receive Meta event, verify HMAC, stage delivery rows
 * per WABA, ACK fast. Actual HTTP fanout happens in the dispatcher.
 */
export async function handleMetaEvent(req: Request, res: Response): Promise<void> {
  const rawBody: Buffer = (req.body as Buffer) ?? Buffer.alloc(0);
  const signature = String(req.header('x-hub-signature-256') || '');
  const signaturePresent = !!signature;
  const bodySize = rawBody.length;

  logger.info(
    `[webhook] POST event — body_size=${bodySize}B, signature_present=${signaturePresent}`
  );

  if (!signaturePresent) {
    await recordHit({
      method: 'POST',
      outcome: 'no_signature',
      http_status: 401,
      reason: 'x-hub-signature-256 header missing',
      body_size: bodySize,
    });
    res.status(401).send('Unauthorized');
    return;
  }

  try {
    const expected =
      'sha256=' + crypto.createHmac('sha256', config.meta.appSecret).update(rawBody).digest('hex');
    let valid = false;
    try {
      valid =
        signature.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      valid = false;
    }
    if (!valid) {
      logger.warn(
        `[webhook] HMAC mismatch — either META_APP_SECRET doesn't match the TSP App, or the body was altered by a proxy.`
      );
      await recordHit({
        method: 'POST',
        outcome: 'signature_invalid',
        http_status: 401,
        reason:
          "HMAC mismatch — check META_APP_SECRET matches the Meta App's secret and no proxy rewrites the body",
        signature_present: true,
        body_size: bodySize,
      });
      res.status(401).send('Unauthorized');
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      logger.warn('[webhook] body was signed but not valid JSON — ACKing and moving on', err);
      await recordHit({
        method: 'POST',
        outcome: 'parse_error',
        http_status: 200,
        reason: 'signed but body is not valid JSON',
        signature_present: true,
        body_size: bodySize,
      });
      res.status(200).send('EVENT_RECEIVED');
      return;
    }

    const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
    const wabaIds: string[] = [];
    let dispatchedCount = 0;

    for (const entry of entries) {
      const wabaId = String(entry?.id || '').trim();
      if (!wabaId) {
        logger.warn('[webhook] entry missing id, skipping');
        continue;
      }
      wabaIds.push(wabaId);

      const reg = await Registration.findByPk(wabaId);
      if (!reg || !reg.enabled) {
        logger.info(
          `[webhook] no registration for waba ${wabaId} — dropping (run 'npm run tenant:list' to inspect)`
        );
        continue;
      }

      const field = entry?.changes?.[0]?.field || null;
      await DeliveryLog.create({
        waba_id: wabaId,
        field,
        payload: { object: payload?.object, entry: [entry] },
        status: 'pending',
      });
      dispatchedCount += 1;
      logger.info(
        `[webhook] queued delivery for waba ${wabaId} field ${field ?? '?'} → ${reg.forward_url}`
      );
    }

    const outcome =
      entries.length === 0
        ? 'accepted_empty'
        : dispatchedCount === 0
        ? 'accepted_unregistered'
        : 'accepted';

    await recordHit({
      method: 'POST',
      outcome,
      http_status: 200,
      waba_ids: wabaIds,
      entry_count: entries.length,
      dispatched_count: dispatchedCount,
      signature_present: true,
      body_size: bodySize,
      reason:
        outcome === 'accepted_unregistered'
          ? 'No registration matched any entry WABA id'
          : outcome === 'accepted_empty'
          ? 'Payload had no entry[]'
          : null,
    });

    setImmediate(() => {
      triggerDispatch().catch((err) => logger.error('[meta] dispatch trigger failed', err));
    });

    res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    logger.error('[webhook] handler error (swallowed, returning 200)', err);
    await recordHit({
      method: 'POST',
      outcome: 'handler_error',
      http_status: 200,
      reason: (err as Error)?.message || 'Unexpected handler error',
      signature_present: true,
      body_size: bodySize,
    });
    res.status(200).send('EVENT_RECEIVED');
  }
}

/**
 * GET /api/v1/webhook-hits — return the last N incoming webhook attempts for
 * ops debugging. Not tenant-authenticated deliberately so operators can curl
 * without needing the tenant secret; it only exposes metadata, never bodies.
 */
export async function handleWebhookHitsList(req: Request, res: Response): Promise<void> {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const rows = await WebhookHit.findAll({
    order: [['id', 'DESC']],
    limit,
  });
  res.json({ status: 'success', data: { hits: rows } });
}
