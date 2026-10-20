// Signed, short-lived tailoring authorisation. The token names one paid generation (a committed
// reservation); tailor-resume checks the signature and expiry here, then the database enforces
// that the generation is really paid and that its tailoring allowance is not used up.
// The raw license code is never put in a token.
const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const mac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest();

// A weak or missing secret disables tailoring instead of issuing forgeable tokens.
function isUsable(secret) {
  return typeof secret === 'string' && secret.length >= 32;
}

function sign(secret, reservationId, ttlSeconds, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const payload = b64u(JSON.stringify({ v: 1, rid: reservationId, iat, exp: iat + ttlSeconds }));
  return `${payload}.${b64u(mac(secret, payload))}`;
}

function verify(secret, token, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [payload, sig] = parts;

  const expected = mac(secret, payload);
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch (e) { return { ok: false, reason: 'malformed' }; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return { ok: false, reason: 'malformed' }; }
  if (!data || data.v !== 1 || typeof data.rid !== 'string' || !UUID_RE.test(data.rid) || !Number.isFinite(data.exp)) {
    return { ok: false, reason: 'malformed' };
  }
  if (data.exp * 1000 <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, reservationId: data.rid, expiresAt: data.exp };
}

module.exports = { isUsable, sign, verify };
