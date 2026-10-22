// The separate cap on "nothing meaningful to improve" polishes (netlify/functions/_lib/nochange.js). Pure, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const nochange = require(path.join('..', '..', 'netlify', 'functions', '_lib', 'nochange'));
const cfg = require(path.join('..', '..', 'netlify', 'functions', '_lib', 'config')).get();

const CODE = 'FG-TEST-0001';
const MIN = 60 * 1000;
const reset = () => nochange._events.clear();

test('allows up to the window limit, then refuses with an accurate retry time that counts down', () => {
  reset(); const t0 = 1_000_000_000_000;
  assert.equal(cfg.NOCHANGE_WINDOW_MAX, 3);
  for (let i = 0; i < 3; i++) { assert.equal(nochange.check(CODE, cfg, t0 + i * MIN).allowed, true); nochange.record(CODE, t0 + i * MIN); }
  const r = nochange.check(CODE, cfg, t0 + 3 * MIN);
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfterSeconds, 12 * 60);                                   // the oldest of the 3 leaves the 15-minute window at t0 + 15 min
  assert.equal(nochange.check(CODE, cfg, t0 + 14 * MIN + 59_000).allowed, false);
  assert.equal(nochange.check(CODE, cfg, t0 + 15 * MIN).allowed, true);         // window passed: one slot is free again
});

test('a different code, and a never-seen code, are not affected', () => {
  reset(); const t0 = 2_000_000_000_000;
  for (let i = 0; i < 3; i++) nochange.record(CODE, t0);
  assert.equal(nochange.check(CODE, cfg, t0).allowed, false);
  assert.equal(nochange.check('FG-TEST-0002', cfg, t0).allowed, true);
});

test('daily cap: spread out over the day it still stops at the daily maximum', () => {
  reset(); const t0 = 3_000_000_000_000;
  for (let i = 0; i < cfg.NOCHANGE_DAY_MAX; i++) { const at = t0 + i * 20 * MIN; assert.equal(nochange.check(CODE, cfg, at).allowed, true, `request ${i + 1}`); nochange.record(CODE, at); }
  const at = t0 + cfg.NOCHANGE_DAY_MAX * 20 * MIN;                               // window is clear, day is full
  const r = nochange.check(CODE, cfg, at); assert.equal(r.allowed, false); assert.ok(r.retryAfterSeconds > 0);
  assert.equal(nochange.check(CODE, cfg, t0 + 24 * 60 * MIN).allowed, true);
});

test('the code itself is never stored (only a hash), and memory is bounded', () => {
  reset(); nochange.record(CODE);
  for (const k of nochange._events.keys()) { assert.equal(k.includes(CODE), false); assert.match(k, /^[0-9a-f]{64}$/); }
  for (let i = 0; i < 700; i++) nochange.record(`FG-LOAD-${i}`);
  assert.ok(nochange._events.size <= 500);
});
