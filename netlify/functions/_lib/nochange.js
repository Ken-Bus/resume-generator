// Separate anti-abuse limit for AI Polish requests that found nothing meaningful to improve.
//
// Those requests are free to the customer (the reservation is released uncounted, so they never touch the database's
// failure budget) but they still cost an AI call. This caps how many a single code can trigger, so they cannot be used
// as an unlimited free AI. It is checked BEFORE any reservation or AI call, and a request it refuses costs nothing.
//
// Best effort by design: kept in memory on the instance that served the request (like the duplicate-request cache), keyed
// by a hash of the code so no code is ever held or logged. The database already serialises paid work to one operation at a
// time per code, which bounds how fast any instance can be asked. A durable, cross-instance limit would need a new
// column on license_reservations (a production schema change) and was deliberately not added.
const crypto = require('crypto');

const events = new Map();                                  // codeHash -> [timestamps of no-change results, newest last]
const MAX_KEYS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const key = (code) => crypto.createHash('sha256').update(`nochange:${code}`).digest('hex');

function prune(list, now) {
  while (list.length && now - list[0] >= DAY_MS) list.shift();
  return list;
}

// -> { allowed: true } or { allowed: false, retryAfterSeconds }
function check(code, cfg, now = Date.now()) {
  const list = events.get(key(code));
  if (!list) return { allowed: true };
  prune(list, now);
  const winMs = cfg.NOCHANGE_WINDOW_SECONDS * 1000;
  const inWin = list.filter((t) => now - t < winMs);
  let wait = 0;
  if (inWin.length >= cfg.NOCHANGE_WINDOW_MAX) wait = Math.max(wait, inWin[inWin.length - cfg.NOCHANGE_WINDOW_MAX] + winMs - now);
  if (list.length >= cfg.NOCHANGE_DAY_MAX) wait = Math.max(wait, list[list.length - cfg.NOCHANGE_DAY_MAX] + DAY_MS - now);
  return wait > 0 ? { allowed: false, retryAfterSeconds: Math.max(Math.ceil(wait / 1000), 1) } : { allowed: true };
}

function record(code, now = Date.now()) {
  const k = key(code);
  const list = prune(events.get(k) || [], now);
  list.push(now);
  events.delete(k); events.set(k, list);                   // most recently used last
  if (events.size > MAX_KEYS) events.delete(events.keys().next().value);
}

module.exports = { check, record, _events: events };
