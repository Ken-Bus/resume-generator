// Authenticated encryption for the temporary recovery copy of a completed AI result (migration 04).
//   * AES-256-GCM, a fresh random 96-bit IV and a fresh random 128-bit salt for EVERY record.
//   * The key is derived with HKDF-SHA256 from a DEDICATED server-side secret (RESULT_ENCRYPTION_KEY, at least 32 characters). It is never
//     the Tailor token secret, never stored in the database, never logged and never shown to a customer. Customers use their access code only.
//   * The record id and the kind (analyze / polish) are bound as authenticated data: a stored row cannot be swapped onto another step, and a
//     tampered row fails to open instead of returning anything.
//   * Rotation: set the new secret as RESULT_ENCRYPTION_KEY and keep the old one as RESULT_ENCRYPTION_KEY_PREVIOUS until the longest-lived copy (24 hours)
//     has expired. Each record stores a key id (the first 8 hex characters of SHA-256 of the secret that sealed it: it reveals nothing usable) and is
//     opened with whichever configured secret has that id.
//   * The plaintext is compressed first (the JSON is repetitive) so the stored copy is small.
// Nothing in this file logs, and it throws errors that carry no content.
const crypto = require('crypto');
const zlib = require('zlib');

const MIN_KEY = 32;
const MAX_PLAIN = 256 * 1024;                                           // a result is a few KB; this only stops a runaway
const usable = (k) => typeof k === 'string' && k.length >= MIN_KEY;
const kidOf = (secret) => crypto.createHash('sha256').update(`fg-result-kid|${secret}`).digest('hex').slice(0, 8);
// key id -> secret, for every configured, usable secret (current first)
const secrets = () => { const out = {}; for (const k of [process.env.RESULT_ENCRYPTION_KEY, process.env.RESULT_ENCRYPTION_KEY_PREVIOUS]) if (usable(k) && !out[kidOf(k)]) out[kidOf(k)] = k; return out; };

// True when the dedicated secret is configured. Without it the paid steps refuse to run: a generation is never charged without a recovery copy.
const ready = () => usable(process.env.RESULT_ENCRYPTION_KEY);

function keyFor(kid, salt, recordId, fn) {
  const secret = secrets()[kid];
  if (!secret) throw new Error('vault: key unavailable');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), salt, Buffer.from(`fg-result-v1|${kid}|${recordId}|${fn}`, 'utf8'), 32));
}
const aad = (recordId, fn) => Buffer.from(`fg-result-v1|${recordId}|${fn}`, 'utf8');

// -> { kid, salt, iv, ct }  (all base64 text; ct = ciphertext followed by the 16-byte authentication tag)
function seal(plaintext, { recordId, fn }) {
  if (!ready()) throw new Error('vault: key unavailable');
  const raw = Buffer.from(String(plaintext), 'utf8');
  if (!raw.length || raw.length > MAX_PLAIN) throw new Error('vault: bad size');
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const kid = kidOf(process.env.RESULT_ENCRYPTION_KEY);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(kid, salt, recordId, fn), iv);
  cipher.setAAD(aad(recordId, fn));
  const body = Buffer.concat([cipher.update(zlib.gzipSync(raw)), cipher.final(), cipher.getAuthTag()]);
  return { kid, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: body.toString('base64') };
}

// -> plaintext string. Throws (with no content in the message) if the key, the record or the data does not match.
function open({ kid, salt, iv, ct }, { recordId, fn }) {
  const body = Buffer.from(String(ct), 'base64');
  if (body.length < 17) throw new Error('vault: bad record');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(String(kid), Buffer.from(String(salt), 'base64'), recordId, fn), Buffer.from(String(iv), 'base64'));
  decipher.setAAD(aad(recordId, fn)); decipher.setAuthTag(body.subarray(body.length - 16));
  const gz = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  const out = zlib.gunzipSync(gz, { maxOutputLength: MAX_PLAIN });
  return out.toString('utf8');
}

module.exports = { ready, seal, open };
