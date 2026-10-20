// Pins the timeout configuration so it cannot silently regress to a value that cuts off longer resumes.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CONFIG = path.join(__dirname, '..', '..', 'netlify', 'functions', '_lib', 'config.js');
const withEnv = (value, fn) => {
  const saved = process.env.AI_TIMEOUT_MS;
  if (value === undefined) delete process.env.AI_TIMEOUT_MS; else process.env.AI_TIMEOUT_MS = value;
  try { return fn(require(CONFIG).get()); } finally { if (saved === undefined) delete process.env.AI_TIMEOUT_MS; else process.env.AI_TIMEOUT_MS = saved; }
};

test('AI_TIMEOUT_MS fallback is 50 s and the lease follows it', () => {
  withEnv(undefined, (c) => {
    assert.equal(c.AI_TIMEOUT_MS, 50000);
    assert.equal(c.LEASE_SECONDS, 70);                    // lease always outlives the AI call by 20 s
  });
});

test('an explicit AI_TIMEOUT_MS wins; junk or too-small values fall back safely', () => {
  withEnv('50000', (c) => assert.equal(c.AI_TIMEOUT_MS, 50000));
  withEnv('22000', (c) => { assert.equal(c.AI_TIMEOUT_MS, 22000); assert.equal(c.LEASE_SECONDS, 45); });   // minimum lease is 45 s
  withEnv('90000', (c) => assert.equal(c.LEASE_SECONDS, 110));                                              // lease still outlives the call
  for (const bad of ['abc', '', '0', '-5', '500']) withEnv(bad, (c) => assert.equal(c.AI_TIMEOUT_MS, 50000, `value ${JSON.stringify(bad)}`));
});

test('the lease always outlives the AI call', () => {
  for (const v of ['1000', '10000', '50000', '58000', '120000']) withEnv(v, (c) => assert.ok(c.LEASE_SECONDS * 1000 >= c.AI_TIMEOUT_MS + 19000, v));
});
