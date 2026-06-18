import type { Request, Response, NextFunction } from 'express';

/**
 * Baseline security headers applied to every response.
 *
 * This router exposes only JSON/text endpoints (Meta webhooks, ops metadata,
 * tenant registration API) plus one self-contained HTML page at
 * /embedded-signup/start. The headers below are safe defaults for an API of
 * this shape; the embedded-signup route deliberately overwrites
 * Content-Security-Policy (and re-asserts X-Frame-Options) afterwards because
 * it must load the Facebook JS SDK — see routes/embeddedSignup.ts. Because that
 * handler runs after this middleware and uses res.setHeader, its values win for
 * that one route.
 *
 * We do NOT set a strict default-src/script-src here: doing so globally would
 * break the embedded-signup page. The minimum CSP below only constrains
 * framing, object embedding, and base URIs, which is appropriate for a
 * JSON/text API surface and does not interfere with any legitimate response.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  // Tell upstream TLS terminators / browsers to stick to HTTPS.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Never let a browser sniff a response into a different content type.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Minimise referrer leakage to third parties.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Drop powerful browser features we never use.
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  // Responses are tenant/secret-adjacent; keep them out of shared caches.
  res.setHeader('Cache-Control', 'no-store');
  // Resources are not meant to be embedded cross-origin.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // No part of this service is meant to be framed (overridden per-route only
  // where a page legitimately needs different framing rules).
  res.setHeader('X-Frame-Options', 'DENY');
  // Minimum CSP for an API surface: forbid framing, plugins, and base-uri
  // hijacking without imposing a default-src that would break the one HTML page.
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
  );
  next();
}
