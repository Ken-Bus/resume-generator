// check-code-supply tops the unassigned code pool up on a schedule. If Netlify also lets anyone call it as a URL, the response must not reveal
// the size of the code inventory (docs/CODE_SUPPLY_EXPOSURE.md); the counts stay in the function log, which only the owner can read.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let unassigned = 50; const inserted = []; const rpcCalls = []; let purgeError = null;
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return { createClient: () => ({ rpc: async (fn) => { rpcCalls.push(fn); if (purgeError === 'throw') throw new Error('boom'); return { data: 0, error: purgeError }; }, from: () => ({
    select: () => ({ eq: async () => ({ count: unassigned, error: null }) }),
    insert: (rows) => ({ select: async () => { inserted.push(...rows); unassigned += rows.length; return { data: rows.map((r) => ({ code: r.code })), error: null }; } })
  }) }) };
  return origLoad.call(this, request, ...rest);
};
Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock' });
const { handler } = require('../../netlify/functions/check-code-supply');

function capture() { const lines = []; const o = [console.log, console.error]; console.log = console.error = (...a) => lines.push(a.map(String).join(' ')); return { lines, restore: () => { [console.log, console.error] = o; } }; }

test('plenty of codes: nothing is generated, the response says nothing about the inventory, the log has the count', async () => {
  unassigned = 50; inserted.length = 0; const c = capture(); let r; try { r = await handler(); } finally { c.restore(); }
  assert.equal(r.statusCode, 200); assert.deepEqual(JSON.parse(r.body), { ok: true }); assert.equal(inserted.length, 0);
  assert.match(c.lines.join('\n'), /50 unassigned codes remaining/);
});
test('low supply: the pool is topped up, the response still reveals no counts, the log has them', async () => {
  unassigned = 3; inserted.length = 0; const c = capture(); let r; try { r = await handler(); } finally { c.restore(); }
  assert.equal(r.statusCode, 200); assert.deepEqual(JSON.parse(r.body), { ok: true }); assert.equal(inserted.length, 100);
  assert.ok(inserted.every((x) => /^FG-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(x.code) && x.max_uses === 5 && x.uses_remaining === 5 && x.assigned === false));
  assert.equal(new Set(inserted.map((x) => x.code)).size, inserted.length, 'codes are unique');
  assert.match(c.lines.join('\n'), /generated 100 new codes/);
});
test('the response never contains a code, a count, or an error detail', async () => {
  unassigned = 0; inserted.length = 0; const c = capture(); let r; try { r = await handler(); } finally { c.restore(); }
  assert.equal(r.body, '{"ok":true}'); assert.equal(inserted.some((x) => r.body.includes(x.code)), false);
});

test('daily housekeeping: the scheduled run erases old request-input hashes (migration 03), and a failing or missing housekeeping function never blocks the code supply', async () => {
  for (const [err, label] of [[null, 'ok'], [{ code: '42883' }, 'migration not applied'], [{ code: 'XX000' }, 'database error'], ['throw', 'exception']]) {
    unassigned = 3; inserted.length = 0; rpcCalls.length = 0; purgeError = err; const c = capture(); let r; try { r = await handler(); } finally { c.restore(); }
    assert.deepEqual(rpcCalls, ['purge_idempotency_hashes'], label); assert.equal(r.statusCode, 200, label); assert.equal(inserted.length, 100, `${label}: the code pool was still topped up`);
  }
  purgeError = null;
});
