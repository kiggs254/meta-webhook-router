import crypto from 'crypto';

/** Compute a `sha256=<hex>` header-style HMAC signature, matching Meta's format. */
export function hmacSha256Hex(secret: string, body: Buffer | string): string {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return 'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');
}

/** Constant-time compare of two signature strings. Returns false on length mismatch. */
export function timingSafeEqual(a: string, b: string): boolean {
  try {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** Generate a random hex secret of given byte length. */
export function randomHexSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
