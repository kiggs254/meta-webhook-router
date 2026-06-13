import dns from 'dns';
import net from 'net';

/**
 * SSRF guard for tenant-controlled forward URLs.
 *
 * A tenant registers an arbitrary `forward_url` that this service will POST
 * webhook payloads to. Without a guard, a tenant could point that URL at an
 * internal address (cloud metadata, the DB, a sibling service on the private
 * network) and use us as a confused deputy. This module:
 *
 *   1. Rejects any scheme that isn't http(s).
 *   2. Resolves the hostname (dns.promises.lookup with { all: true }) and
 *      rejects if ANY resolved address is private / loopback / link-local /
 *      unique-local / carrier-grade-NAT / metadata / unspecified.
 *
 * It is dependency-free (node `dns` + `net` only) so it can be called both at
 * registration time (reject the registration) and again immediately before
 * each dispatch (defends against DNS-rebinding / TOCTOU, where a name that
 * resolved public at registration later resolves to a private address).
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** Strip an IPv4-mapped/compat IPv6 prefix so the embedded v4 address can be range-checked. */
function unwrapMappedV4(addr: string): string | null {
  const lower = addr.toLowerCase();
  // ::ffff:a.b.c.d  and the deprecated ::a.b.c.d  forms.
  const m = lower.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) return m[1];
  // ::ffff:hhhh:hhhh hexadecimal form of an IPv4-mapped address.
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

function inV4Cidr(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unpar. able → treat as unsafe.
  return (
    inV4Cidr(n, '10.0.0.0', 8) ||
    inV4Cidr(n, '172.16.0.0', 12) ||
    inV4Cidr(n, '192.168.0.0', 16) ||
    inV4Cidr(n, '127.0.0.0', 8) ||
    inV4Cidr(n, '169.254.0.0', 16) || // link-local + metadata 169.254.169.254
    inV4Cidr(n, '100.64.0.0', 10) || // carrier-grade NAT
    inV4Cidr(n, '0.0.0.0', 8) // "this" network, incl. 0.0.0.0
  );
}

function isPrivateV6(addrRaw: string): boolean {
  const addr = addrRaw.toLowerCase().split('%')[0]; // drop any zone id.

  // Loopback and unspecified.
  if (addr === '::1' || addr === '::' || addr === '0:0:0:0:0:0:0:1') return true;

  // IPv4-mapped / compatible → check the embedded v4 range.
  const mapped = unwrapMappedV4(addr);
  if (mapped) return isPrivateV4(mapped);

  // Unique-local fc00::/7  → first byte 0xfc or 0xfd.
  if (/^f[cd][0-9a-f]{0,2}:/.test(addr)) return true;

  // Link-local fe80::/10 → fe80..febf.
  if (/^fe[89ab][0-9a-f]?:/.test(addr)) return true;

  return false;
}

/** True when a resolved IP literal points somewhere we must not forward to. */
function isDisallowedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (net.isIPv6(ip)) return isPrivateV6(ip);
  return true; // not a recognisable IP → unsafe.
}

/**
 * Validate a forward URL against SSRF. Throws {@link SsrfError} on rejection.
 * Resolves DNS, so it is async and must be awaited.
 */
export async function assertSafeForwardUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('forward_url is not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('forward_url must use http or https');
  }

  const host = url.hostname.replace(/^\[|\]$/g, ''); // unwrap [::1] literals.
  if (!host) {
    throw new SsrfError('forward_url has no host');
  }

  // If the host is already an IP literal, range-check it directly (no DNS).
  if (net.isIP(host)) {
    if (isDisallowedAddress(host)) {
      throw new SsrfError('forward_url resolves to a disallowed (private/loopback/metadata) address');
    }
    return;
  }

  // Block the obvious localhost aliases before paying for a lookup.
  const lowerHost = host.toLowerCase();
  if (lowerHost === 'localhost' || lowerHost.endsWith('.localhost')) {
    throw new SsrfError('forward_url resolves to a disallowed (private/loopback/metadata) address');
  }

  let resolved: dns.LookupAddress[];
  try {
    resolved = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new SsrfError('forward_url host could not be resolved');
  }

  if (resolved.length === 0) {
    throw new SsrfError('forward_url host could not be resolved');
  }

  for (const { address } of resolved) {
    if (isDisallowedAddress(address)) {
      throw new SsrfError('forward_url resolves to a disallowed (private/loopback/metadata) address');
    }
  }
}

/** Non-throwing convenience wrapper for callers that just want a boolean. */
export async function isSafeForwardUrl(raw: string): Promise<boolean> {
  try {
    await assertSafeForwardUrl(raw);
    return true;
  } catch {
    return false;
  }
}
