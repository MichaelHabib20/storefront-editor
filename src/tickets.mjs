/**
 * Stream tickets (plan step 6): the backend, after checking the admin's login and permission, signs
 * "store + expiry" with the shared editor key; the admin page opens the event stream with it. The browser never holds
 * the key. Format: base64url(JSON {s, e}) "." base64url(HMAC-SHA256(key, payload)). Same in PHP (EditorClient).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

export function signTicket(key, storeId, expiresAt) {
  const payload = b64url(JSON.stringify({ s: storeId, e: Math.floor(expiresAt) }));
  return `${payload}.${b64url(createHmac('sha256', key).update(payload).digest())}`;
}

/** @returns {{ ok: true, expiresAt: number } | { ok: false, reason: string }} expiresAt in unix seconds */
export function verifyTicket(key, ticket, storeId, now = Date.now() / 1000) {
  if (!key) return { ok: false, reason: 'no_key' };
  const [payload, signature] = String(ticket ?? '').split('.');
  if (!payload || !signature) return { ok: false, reason: 'malformed' };
  const expected = createHmac('sha256', key).update(payload).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' };
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (data.s !== storeId) return { ok: false, reason: 'other_store' };
  if (!(data.e > now)) return { ok: false, reason: 'expired' };
  return { ok: true, expiresAt: data.e };
}
