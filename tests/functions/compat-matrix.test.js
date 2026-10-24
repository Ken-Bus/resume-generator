// Application x database compatibility matrix (real local PostgreSQL, AI mocked). Answers: which application can safely run against which database state?
//   Applications:  P1 = the previous application (commit b6884f3: reservation accounting, in-memory repeat protection, never sends a request key)
//                  N  = this branch (sends a request key with every paid step)
//   Database:      B = migration 01 | C = 01+02 | D = 01+02+03 | R = D after the rollback script
// P1 is loaded from git history, unmodified. The migration-03 review package quotes these results.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const Module = require('module');
const { H, loadHandlers, post, parseBody, installAi } = require('./harness');

const ROOT = path.join(__dirname, '..', '..');
const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const PREVIOUS = 'b6884f3';
const TEXT = 'Jordan Ellis. Retail Associate at Fictional Maple Market, June 2023 to August 2026. Assisted customers at the register and stocked shelves.';
const BASE = ['Rang up purchases for custmers', 'Counted the cash drawer at clossing', 'Stocked shelves with new merchandize', 'Answered questons about prices'];
const FIXED = ['Rang up purchases for customers', 'Counted the cash drawer at closing', 'Stocked shelves with new merchandise', 'Answered questions about prices'];
const RESUME = { name: 'Lena Ortiz', contact: { email: 'lena.ortiz@example.com' }, summary: { tagline: 'Retail clerk', bullets: [], skills: ['Cash handling'] },
  experience: [{ title: 'Retail Clerk', company: 'Fictional Dollar Shop', location: '', start: '2020', end: '2024', summary: '', bullets: BASE }],
  education: [], certifications: [], projects: [], volunteer: [], awards: [] };
const fixAll = (r) => { const o = JSON.parse(JSON.stringify(r)); o.experience[0].bullets = FIXED.slice(); return o; };

function previousApplication() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prevapp-'));
  execSync(`git archive ${PREVIOUS} | tar -x -C ${dir}`, { cwd: ROOT }); fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}
function loadFrom(dir) {                                              // a cold instance of the application rooted at `dir`
  for (const k of Object.keys(require.cache)) if (k.startsWith(dir)) delete require.cache[k];
  const f = (n) => require(path.join(dir, 'netlify', 'functions', n));
  return { parse: f('parse-resume').handler, polish: f('polish-resume').handler };
}

test('application x database compatibility matrix (real SQL, AI mocked)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const rollback = fs.readFileSync(path.join(ROOT, 'supabase', 'rollback', '20261023_03_rollback.sql'), 'utf8');
  const prevDir = previousApplication();
  const ai = installAi({}); ai.polishPayload = fixAll;
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'mock', TAILOR_TOKEN_SECRET: SECRET, AI_TIMEOUT_MS: '1000' });

  const states = {};
  for (const [name, steps] of [['B', [H.MIG1]], ['C', [H.MIG1, H.MIG2]], ['D', [H.MIG1, H.MIG2, H.MIG3]], ['R', [H.MIG1, H.MIG2, H.MIG3, 'ROLLBACK']]]) {
    const db = await H.freshDatabase(`rg_cm_${name.toLowerCase()}`); await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db);
    for (const m of steps) { if (m === 'ROLLBACK') await db.admin(rollback); else await H.applyMigration(db, m); }
    states[name] = db;
  }
  let n = 0;
  const seed = async (db, uses = 5) => { const c = `FG-M${String(++n).padStart(3, '0')}-MMMM`; await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const uses = async (db, c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const coldInstance = (db, app) => { loadHandlers(db.pool('service_role', 10)); return app === 'N' ? loadHandlers(db.pool('service_role', 10)) : loadFrom(prevDir); };

  // Run one lifecycle with an application against a database; returns what a customer would see.
  async function lifecycle(app, stateName) {
    const db = states[stateName]; const c = await seed(db); const out = {};
    const inst1 = coldInstance(db, app); const call = (inst, fn, body) => (fn === 'analyze' ? inst.parse : inst.polish)(post(body));
    const a = await call(inst1, 'analyze', { code: c, resumeText: TEXT, requestId: 'matrix-analyze-1' }); out.analyze = [a.statusCode, await uses(db, c)];
    const p = await call(inst1, 'polish', { code: c, resume: RESUME, target: 'retail', requestId: 'matrix-polish-1' }); out.polish = [p.statusCode, parseBody(p).charged === true, await uses(db, c)];
    const inst2 = coldInstance(db, app);                                              // the reply was lost; the retry reaches a cold instance
    const a2 = await call(inst2, 'analyze', { code: c, resumeText: TEXT, requestId: 'matrix-analyze-1' }); out.retryAnalyze = [a2.statusCode, await uses(db, c)];
    const noId = await call(inst2, 'analyze', { code: c, resumeText: TEXT }); out.noId = [noId.statusCode, await uses(db, c)];   // an older page, no request id
    return out;
  }

  await t.test('P1 (previous application) works unchanged on B, C, D and R; its own cold-retry limitation is the same everywhere', async () => {
    const r = {}; for (const s of ['B', 'C', 'D', 'R']) r[s] = await lifecycle('P1', s);
    assert.deepEqual(r.C, r.B); assert.deepEqual(r.D, r.B); assert.deepEqual(r.R, r.B);
    assert.deepEqual(r.B.analyze, [200, 4]); assert.deepEqual(r.B.polish, [200, true, 3]);
    // The previous application protects a retry only in memory on one instance. A cold instance charges again. This is the behaviour that exists
    // BEFORE migration 03 and AFTER a rollback; durable protection needs migration 03 AND the new application.
    assert.deepEqual(r.B.retryAnalyze, [200, 2], 'KNOWN LIMITATION of the previous application (not a regression)');
    assert.deepEqual(r.B.noId, [200, 1]);
  });

  await t.test('N (this branch) on D: durable. A retry on a cold instance is not charged again', async () => {
    const r = await lifecycle('N', 'D');
    assert.deepEqual(r.analyze, [200, 4]); assert.deepEqual(r.polish, [200, true, 3]);
    assert.deepEqual(r.retryAnalyze, [200, 3], 'recovered, not charged'); assert.deepEqual(r.noId, [200, 2], 'a request without an id is an ordinary new request');
  });

  await t.test('N (this branch) on B, C and R (no migration 03 / rolled back): a keyed step fails closed ("try again"), charges nothing, calls no AI; an unkeyed request still works', async () => {
    for (const s of ['B', 'C', 'R']) {
      const db = states[s]; const c = await seed(db); const inst = coldInstance(db, 'N'); ai.calls = 0;
      const a = await inst.parse(post({ code: c, resumeText: TEXT, requestId: 'matrix-closed-1' })); const p = await inst.polish(post({ code: c, resume: RESUME, requestId: 'matrix-closed-2' }));
      assert.equal(a.statusCode, 503, s); assert.equal(p.statusCode, 503, s); assert.equal(await uses(db, c), 5, `${s}: nothing charged`); assert.equal(ai.calls, 0, `${s}: no AI call`);
      assert.equal((await inst.parse(post({ code: c, resumeText: TEXT }))).statusCode, 200, `${s}: an older-page request without an id works`); assert.equal(await uses(db, c), 4, s);
    }
  });

  await t.test('ROLLBACK keeps every balance and every committed step; rolling forward again restores the protection for steps paid before the rollback', async () => {
    const db = await H.freshDatabase('rg_cm_rb2'); await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db);
    for (const m of [H.MIG1, H.MIG2, H.MIG3]) await H.applyMigration(db, m);
    const c = await seed(db); const inst = coldInstance(db, 'N'); await inst.parse(post({ code: c, resumeText: TEXT, requestId: 'matrix-rb-1' })); assert.equal(await uses(db, c), 4);
    const snap = async () => JSON.stringify({ lic: (await db.admin('select code, uses_remaining, max_uses from licenses order by code')).rows, rsv: (await db.admin("select id, code, status from license_reservations order by id")).rows });
    const before = await snap(); await db.admin(rollback);
    assert.equal(await snap(), before, 'no balance restored, no charge discarded, no row removed');
    const prev = loadFrom(prevDir); loadHandlers(db.pool('service_role', 10)); const again = loadFrom(prevDir);
    assert.equal((await again.parse(post({ code: c, resumeText: TEXT }))).statusCode, 200); assert.equal(await uses(db, c), 3, 'the previous application keeps charging correctly after the rollback');
    await H.applyMigration(db, H.MIG3);
    const fwd = coldInstance(db, 'N'); const r = await fwd.parse(post({ code: c, resumeText: TEXT, requestId: 'matrix-rb-1' }));
    assert.equal(r.statusCode, 200); assert.equal(parseBody(r).recovered, 'regenerated', 'the step paid before the rollback is still recognised after rolling forward'); assert.equal(await uses(db, c), 3);
    void prev; await db.close();
  });

  for (const db of Object.values(states)) await db.close();
});
