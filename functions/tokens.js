// Scenario tokens: random per-instance identifiers bound to exactly one lane.
//
//   token = <laneCode>.<instanceId>.<expiry>.<mac>
//     laneCode   two digits (lane binding; a token for lane 02 never validates on lane 03)
//     instanceId 16 random bytes, base64url (one scenario instance = one token)
//     expiry     unix seconds, base36
//     mac        HMAC-SHA256(signing key, "nsv1|code|id|expiry"), base64url
//
// Validation is stateless (works on every platform and instance); per-instance fixture state
// lives in the state store (functions/state.js).

const TOKEN_RE = /^(\d{2})\.([A-Za-z0-9_-]{22})\.([0-9a-z]{1,10})\.([A-Za-z0-9_-]{43})$/;
const enc = new TextEncoder();

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromB64url(text) {
  const s = atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const material = (code, id, exp) => enc.encode(`nsv1|${code}|${id}|${exp}`);

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Issue a fresh token for a lane code. */
export async function issueToken(config, code, { now = nowSeconds(), ttl = config.tokenTtl } = {}) {
  const id = b64url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const exp = (now + ttl).toString(36);
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', config.tokenKey, material(code, id, exp)));
  return { token: `${code}.${id}.${exp}.${b64url(mac)}`, id, code, expiresAt: now + ttl };
}

/**
 * Validate a token. When expectedCode is given the token must belong to that lane.
 * @returns {Promise<{ok: true, code, id, expiresAt} | {ok: false, reason: 'malformed'|'invalid'|'cross_lane'|'expired'}>}
 */
export async function verifyToken(config, token, { expectedCode = null, now = nowSeconds() } = {}) {
  const m = typeof token === 'string' ? TOKEN_RE.exec(token) : null;
  if (!m) return { ok: false, reason: 'malformed' };
  const [, code, id, exp, mac] = m;
  let sig;
  try { sig = fromB64url(mac); } catch { return { ok: false, reason: 'malformed' }; }
  // Canonical encoding only: one token string per signature (no padding-bit variants).
  if (b64url(sig) !== mac) return { ok: false, reason: 'malformed' };
  const valid = await globalThis.crypto.subtle.verify('HMAC', config.tokenKey, sig, material(code, id, exp));
  if (!valid) return { ok: false, reason: 'invalid' };
  if (expectedCode !== null && code !== expectedCode) return { ok: false, reason: 'cross_lane' };
  const expiresAt = parseInt(exp, 36);
  if (!(expiresAt > now)) return { ok: false, reason: 'expired' };
  return { ok: true, code, id, expiresAt };
}

/** HMAC signature over arbitrary text (receipts). */
export async function signText(config, text) {
  return b64url(new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', config.tokenKey, enc.encode(`nsr1|${text}`))));
}

/** Constant-time-ish comparison of two secrets via their SHA-256 digests. */
export async function secretEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [x, y] = await Promise.all([a, b].map(async (v) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(v)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Pattern used to redact tokens from logs. */
export const TOKEN_IN_TEXT = /\d{2}\.[A-Za-z0-9_-]{22}\.[0-9a-z]{1,10}\.[A-Za-z0-9_-]{43}/g;
