// The charging path (real SQL, mocked AI) for the writing-quality personas: a genuinely improved resume is applied and charged exactly once,
// a clear resume is left alone for free, and the accepted result is exactly the corrected resume.
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, loadHandlers, post, parseBody, installAi } = require('./harness');
const Core = require('../../resume-core.js');
const { C } = require('./quality-corpus');
const clone = (o) => JSON.parse(JSON.stringify(o));

test('quality personas through polish-resume against real SQL (AI mocked)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_quality');
  await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2);
  const hs = loadHandlers(db.pool('service_role', 20)); const ai = installAi({});
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'TESTKEY-Q', TAILOR_TOKEN_SECRET: 'test-secret-test-secret-test-secret-0123456789', AI_TIMEOUT_MS: '2000' });
  let n = 0; const seed = async () => { const c = `FG-${(++n).toString(36).toUpperCase().padStart(4, 'Q')}-FFFF`; await H.seed(db, [{ code: c, uses: 5, assigned: true }]); return c; };
  const uses = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const run = async (c, resume, payload) => { hs.polishModule._recent.clear(); hs.polishModule._nochange._events.clear(); ai.polishPayload = payload; return parseBody(await hs.polish(post({ code: c, resume, target: 'customer service' }))); };

  for (const [name, c] of Object.entries(C)) {
    if (!c.after || name === 'spellingOnly') continue;
    await t.test(`${name}: the corrected resume is accepted whole, applied, and charged exactly once`, async () => {
      const code = await seed(); const b = await run(code, c.before, () => clone(c.after));
      assert.equal(b.charged, true); assert.deepEqual(b.withheld, []); assert.equal(await uses(code), 4);
      assert.deepEqual(Core.clean(JSON.parse(b.result)), Core.clean(c.after));
      assert.ok(b.changes.reworded >= 1);
    });
    await t.test(`${name}: the same resume with an invented line added to the good edit: one charge, the invention is gone, the rest is kept`, async () => {
      const code = await seed(); const out = clone(c.after); const e = out.experience[0] || out.volunteer[0] || out.projects[0]; e.bullets.push('Led a team of 12 and increased sales by 40%');
      const b = await run(code, c.before, () => out); const res = JSON.parse(b.result);
      assert.equal(b.charged, true); assert.equal(await uses(code), 4); assert.equal(JSON.stringify(res).includes('40%'), false); assert.equal(JSON.stringify(res).includes('Led a team'), false);
      assert.ok(b.withheld.length >= 1);
    });
  }
  await t.test('already-clear resume: the AI returns it unchanged: free, nothing applied; a cosmetic-only tidy is also free', async () => {
    const code = await seed(); let b = await run(code, C.polished.before, (r) => clone(r)); assert.equal(b.noChange, true); assert.equal(await uses(code), 5);
    b = await run(code, C.polished.before, (r) => { const o = clone(r); o.experience[0].bullets = o.experience[0].bullets.map((x) => `${x}.`); return o; }); assert.equal(b.noChange, true); assert.equal(await uses(code), 5);
  });
  await t.test('CURRENT rule, documented: a spelling-only fix of six lines is free and not applied (see docs/PROPOSAL_COLLECTIVE_CHARGING.md)', async () => {
    const code = await seed(); const b = await run(code, C.spellingOnly.before, () => clone(C.spellingOnly.after));
    assert.equal(b.noChange, true); assert.equal(b.reason, 'minor'); assert.equal(await uses(code), 5); assert.equal(b.result, undefined); assert.equal(b.changes.minor, 6);
  });
});
