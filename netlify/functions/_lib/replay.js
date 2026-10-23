// Replay protection for the paid AI steps (Analyze and AI Polish): when the browser repeats a request that already finished (the reply was lost,
// the page was reloaded), the SAME answer comes back and nothing is charged twice. The page sends one `requestId` per attempt and reuses it on a retry.
//
// Best effort by design: the answers are kept in memory on the instance that produced them, for a few minutes (a durable, cross-instance version
// would need a new column or table in the production database, which is a schema change and was deliberately not made). A retry that lands on a
// different or restarted instance is simply a new request: it is protected by the one-at-a-time check and the license balance, never by this cache.
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

module.exports = { validId, get, put, recent, REQUEST_ID_RE };
