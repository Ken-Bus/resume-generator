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
const keyOf = (fn, code, id) => crypto.createHash('sha256').update(`${fn}:${code}:${id}`).digest('hex');
function get(fn, code, id) {
  const k = keyOf(fn, code, id); const v = recent.get(k);
  if (v && Date.now() - v.at < RECENT_MS) return v.body;
  recent.delete(k); return null;
}
function put(fn, code, id, body) {
  recent.set(keyOf(fn, code, id), { at: Date.now(), body });
  if (recent.size > 200) recent.delete(recent.keys().next().value);
}

// What the DATABASE needs to recognise a repeat (migration 03): two hashes, never the request id or the customer's text.
const requestKey = (fn, id) => crypto.createHash('sha256').update(`key:${fn}:${id}`).digest('hex');
const inputHash = (value) => crypto.createHash('sha256').update(`in:${typeof value === 'string' ? value : JSON.stringify(value)}`).digest('hex');
function repeatOf(fn, id, input) { return id ? { key: requestKey(fn, id), inputHash: inputHash(input) } : undefined; }

module.exports = { repeatOf, requestKey, inputHash, validId, get, put, recent, REQUEST_ID_RE };
