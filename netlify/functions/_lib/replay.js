// Repeat protection for the paid AI steps (Analyze and AI Polish): when the browser repeats a request that already finished (the reply was lost,
// the page was reloaded), the customer must never be charged twice. The page sends one `requestId` per attempt and reuses it on a retry.
//
// Two layers:
//   1. DURABLE (migration 03): the database remembers, for a committed paid step, a hash of the request id and a hash of the input. A repeat of the
//      same step, on ANY instance, after any restart, is answered 'replay' by reserve_license_use: no new reservation, no second charge; the result is
//      re-delivered (the AI runs again, limited to 3 times per paid step, one at a time). See supabase/migrations/20261023_03_request_idempotency.sql.
//   2. FAST PATH (this file): the exact answer is also kept in memory on the instance that produced it for a few minutes, so the common retry returns the
//      same text instantly with no AI call. It is an optimisation only; billing safety never depends on it.
const crypto = require('crypto');

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const RECENT_MS = 5 * 60 * 1000;
const recent = new Map();                                       // key -> { at, body }

const validId = (id) => (typeof id === 'string' && REQUEST_ID_RE.test(id) ? id : null);
// The key holds a hash, never the license code or the request id itself.
// The input is part of the key: the same id with DIFFERENT input must never be answered with the earlier input's result.
const keyOf = (fn, code, id, input) => crypto.createHash('sha256').update(`${fn}:${code}:${id}:${typeof input === 'string' ? input : JSON.stringify(input)}`).digest('hex');
function get(fn, code, id, input) {
  const k = keyOf(fn, code, id, input); const v = recent.get(k);
  if (v && Date.now() - v.at < RECENT_MS) return v.body;
  recent.delete(k); return null;
}
function put(fn, code, id, input, body) {
  recent.set(keyOf(fn, code, id, input), { at: Date.now(), body });
  if (recent.size > 200) recent.delete(recent.keys().next().value);
}

// What the DATABASE needs to recognise a repeat (migration 03): two KEYED hashes, never the request id or the customer's text. They are HMAC-SHA256
// with the server's existing TAILOR_TOKEN_SECRET (domain-separated), so the stored values cannot be matched to a guessed resume or id without the
// secret. If that secret is missing or short (it also disables tailoring) a plain SHA-256 is used instead, consistently on every instance.
// Rotating the secret makes earlier keys unrecognisable: a retry of a step paid before the rotation would then be treated as a new step, so rotate
// only when no customer is mid-step (documented in docs/MIGRATION_03_REVIEW_PACKAGE.md).
const macSecret = () => { const k = process.env.TAILOR_TOKEN_SECRET; return typeof k === 'string' && k.length >= 32 ? k : null; };
const mac = (label, value) => { const k = macSecret(); const text = `${label}:${value}`; return k ? crypto.createHmac('sha256', k).update(text).digest('hex') : crypto.createHash('sha256').update(text).digest('hex'); };
const requestKey = (fn, id) => mac('key', `${fn}:${id}`);
const inputHash = (value) => mac('in', typeof value === 'string' ? value : JSON.stringify(value));
function repeatOf(fn, id, input) { return id ? { key: requestKey(fn, id), inputHash: inputHash(input) } : undefined; }

module.exports = { repeatOf, requestKey, inputHash, validId, get, put, recent, REQUEST_ID_RE };
