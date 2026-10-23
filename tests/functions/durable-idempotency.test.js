// Durable duplicate-charge protection (migration 03): a repeat of an already-paid Analyze or AI Polish step is recognised by the DATABASE, so it
// works across independent serverless instances, cold starts and restarts. Every "instance" below is a freshly loaded set of handlers with its own
// empty memory and its own database pool (the in-memory replay cache of one instance can never help another). Real handlers, real SQL, mocked AI.
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, loadHandlers, post, parseBody, installAi, captureLogs, realReword } = require('./harness');

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
let seq = 0;
const newCode = () => `FG-D${String(++seq).padStart(3, '0')}-DDDD`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const TEXT = 'Jordan Ellis. Retail Associate at Fictional Maple Market, June 2023 to August 2026. Assisted customers at the register and stocked shelves.';
const BASE = ['Rang up purchases for custmers', 'Counted the cash drawer at clossing', 'Stocked shelves with new merchandize', 'Answered questons about prices'];
const FIXED = ['Rang up purchases for customers', 'Counted the cash drawer at closing', 'Stocked shelves with new merchandise', 'Answered questions about prices'];
const RESUME = { name: 'Lena Ortiz', contact: { email: 'lena.ortiz@example.com' }, summary: { tagline: 'Retail clerk', bullets: [], skills: ['Cash handling'] },
  experience: [{ title: 'Retail Clerk', company: 'Fictional Dollar Shop', location: '', start: '2020', end: '2024', summary: '', bullets: BASE }],
  education: [], certifications: [], projects: [], volunteer: [], awards: [] };
const fixAll = (r) => { const o = clone(r); o.experience[0].bullets = FIXED.slice(); return o; };

test('durable idempotency across independent instances (real SQL, AI mocked)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_durable');
  await db.admin(H.SUPABASE_DEFAULT_PRIVS);
  await H.liveState(db); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2); await H.applyMigration(db, H.MIG3);
  const ai = installAi({});
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'mock', TAILOR_TOKEN_SECRET: SECRET, AI_TIMEOUT_MS: '1000' });
  // A new instance = new handler modules, new (empty) memory, new database connection pool. It is used once before the next one is created.
  const instances = [];
  const instance = async () => { const hs = loadHandlers(db.pool('service_role', 10)); instances.push(hs); await hs.verify(post({ code: 'FG-ZZZZ-ZZZZ' })).catch(() => {}); return hs; };
  const seed = async (uses = 5) => { const c = newCode(); await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const uses = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const rsv = async (c) => (await db.admin('select status from license_reservations where code=$1 order by created_at', [c])).rows.map((x) => x.status);
  const reset = () => { ai.mode = 'ok'; ai.delayMs = 0; ai.calls = 0; ai.maxInflight = 0; ai.polishPayload = null; };
  const analyze = (hs, code, extra = {}) => hs.parse(post({ code, resumeText: TEXT, ...extra }));
  const polish = (hs, code, extra = {}, resume = RESUME) => hs.polish(post({ code, resume, target: 'retail', ...extra }));

  await t.test('ANALYZE: charged on instance A, reply lost, retry lands on a cold instance B: same request id is NOT charged again and the result is re-delivered', async () => {
    reset(); const c = await seed(); const A = await instance(); const B = await instance();
    const first = parseBody(await analyze(A, c, { requestId: 'req-analyze-0001' }));
    assert.equal(first.usesRemaining, 4); assert.equal(await uses(c), 4);                     // charged once; this reply is "lost"
    const again = await analyze(B, c, { requestId: 'req-analyze-0001' }); const b = parseBody(again);
    assert.equal(again.statusCode, 200); assert.ok(b.result); assert.equal(b.usesRemaining, 4); assert.ok(b.tailorToken);
    assert.equal(await uses(c), 4, 'still charged exactly once'); assert.deepEqual(await rsv(c), ['committed']);
    assert.equal(JSON.parse(b.result).name, JSON.parse(first.result).name);
  });

  await t.test('POLISH: the same, through a restart (new pool, empty memory); the re-delivered tailoring token still works for the paid generation', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixAll; const A = await instance();
    const first = parseBody(await polish(A, c, { requestId: 'req-polish-0001' }));
    assert.equal(first.charged, true); assert.equal(await uses(c), 4);
    const B = await instance();                                                                // "restart"
    const second = await polish(B, c, { requestId: 'req-polish-0001' }); const b = parseBody(second);
    assert.equal(second.statusCode, 200); assert.equal(b.charged, true); assert.equal(JSON.parse(b.result).experience[0].bullets[0], FIXED[0]);
    assert.equal(b.usesRemaining, 4); assert.equal(await uses(c), 4); assert.deepEqual(await rsv(c), ['committed']);
    const tailor = await B.tailor(post({ resumeData: JSON.parse(b.result), tailorToken: b.tailorToken, jobDescription: 'Retail clerk: cash handling and customer service.' }));
    assert.notEqual(tailor.statusCode, 401, 'the paid generation can still be tailored after a re-delivery');
  });

  await t.test('a different request id, or the customer changing the text, is a NEW step and is charged normally', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixAll; const A = await instance(); const B = await instance();
    await polish(A, c, { requestId: 'req-polish-0002' }); assert.equal(await uses(c), 4);
    await polish(B, c, { requestId: 'req-polish-0003' }); assert.equal(await uses(c), 3, 'another request id: another step');
    const edited = clone(RESUME); edited.experience[0].bullets = [...BASE.slice(0, 3), 'Answered questons about prices and returns'];
    ai.polishPayload = (r) => { const o = clone(r); o.experience[0].bullets = [FIXED[0], FIXED[1], FIXED[2], 'Answered questions about prices and returns']; return o; };
    await polish(B, c, { requestId: 'req-polish-0002' }, edited); assert.equal(await uses(c), 2, 'same id but different text: a new step, never a stale result');
  });

  await t.test('FAULT: the re-delivery fails (AI outage) -> 502, nothing charged, its turn is given back so the NEXT retry can still be re-delivered', async () => {
    reset(); const c = await seed(); const A = await instance(); const B = await instance();
    await analyze(A, c, { requestId: 'req-analyze-0002' });
    ai.mode = 'http500'; const failed = await analyze(B, c, { requestId: 'req-analyze-0002' });
    assert.equal(failed.statusCode, 502); assert.equal(await uses(c), 4);
    ai.mode = 'ok'; const ok = await analyze(B, c, { requestId: 'req-analyze-0002' });
    assert.equal(ok.statusCode, 200); assert.ok(parseBody(ok).result); assert.equal(await uses(c), 4);
  });

  await t.test('CONCURRENCY: five simultaneous retries of a lost reply across three cold instances: one re-delivery runs, the rest are told to wait, nothing is charged', async () => {
    reset(); const c = await seed(); const A = await instance(); const B = await instance(); const C = await instance(); const D = await instance();
    await analyze(A, c, { requestId: 'req-analyze-0003' }); ai.calls = 0; ai.delayMs = 400;
    const rs = await Promise.all([B, C, D, B, C].map((hs) => analyze(hs, c, { requestId: 'req-analyze-0003' })));
    assert.equal(rs.filter((r) => r.statusCode === 200).length, 1); assert.equal(rs.filter((r) => r.statusCode === 409).length, 4);
    assert.equal(ai.calls, 1); assert.equal(await uses(c), 4);
  });

  await t.test('LIMIT: after three re-deliveries the customer gets a clear message (no further AI, no charge); an EXHAUSTED code still re-delivers its paid step', async () => {
    reset(); const c = await seed(1); const A = await instance();
    await analyze(A, c, { requestId: 'req-analyze-0004' }); assert.equal(await uses(c), 0);
    for (let i = 0; i < 3; i++) assert.equal((await analyze(await instance(), c, { requestId: 'req-analyze-0004' })).statusCode, 200);
    ai.calls = 0; const last = await analyze(await instance(), c, { requestId: 'req-analyze-0004' });
    assert.equal(last.statusCode, 409); assert.match(parseBody(last).error, /message us with your access code/); assert.equal(ai.calls, 0); assert.equal(await uses(c), 0);
  });

  await t.test('FAULT: a free (below-threshold) polish is not remembered as paid: its retry is an ordinary free attempt, and nothing is ever charged for it', async () => {
    reset(); const c = await seed(); ai.polishPayload = (r) => { const o = clone(r); o.experience[0].bullets[0] = FIXED[0]; return o; };
    const A = await instance(); const B = await instance();
    const a = parseBody(await polish(A, c, { requestId: 'req-polish-0004' })); assert.equal(a.charged, false);
    const b = parseBody(await polish(B, c, { requestId: 'req-polish-0004' })); assert.equal(b.charged, false);
    assert.equal(await uses(c), 5); assert.ok((await rsv(c)).every((s) => s === 'released'));
  });

  await t.test('FAULT: the original request is still running on A when the browser retries on B (slow AI): B is turned away uncharged; once A finishes, the retry is a safe re-delivery', async () => {
    reset(); const c = await seed(); const A = await instance(); const B = await instance(); ai.delayMs = 500;
    const slow = analyze(A, c, { requestId: 'req-analyze-0005' });
    await new Promise((r) => setTimeout(r, 120));
    const early = await analyze(B, c, { requestId: 'req-analyze-0005' }); assert.equal(early.statusCode, 409);
    assert.equal((await slow).statusCode, 200); assert.equal(await uses(c), 4);
    ai.delayMs = 0; const later = await analyze(B, c, { requestId: 'req-analyze-0005' }); assert.equal(later.statusCode, 200); assert.equal(await uses(c), 4);
  });

  await t.test('PRIVACY: the database holds only two hashes for a step; no request id, resume text or name is stored; logs carry no code, text or request id', async () => {
    reset(); const c = await seed(); const A = await instance(); const cap = captureLogs();
    try { await analyze(A, c, { requestId: 'req-analyze-secretid-9' }); await analyze(await instance(), c, { requestId: 'req-analyze-secretid-9' }); } finally { cap.restore(); }
    const row = (await db.admin('select * from license_reservations where code=$1', [c])).rows[0];
    const dump = JSON.stringify(row);
    for (const needle of ['req-analyze-secretid-9', 'Jordan', 'Maple', 'register']) assert.equal(dump.includes(needle), false, `row must not contain ${needle}`);
    assert.match(row.request_key, /^[0-9a-f]{64}$/); assert.match(row.input_hash, /^[0-9a-f]{64}$/);
    const logs = cap.lines.join('\n');
    for (const needle of [c, 'req-analyze-secretid-9', 'Jordan', 'Maple Market']) assert.equal(logs.includes(needle), false, `logs must not contain ${needle}`);
  });

  await t.test('COMPATIBILITY: the page sends no request id (an older page): behaviour is exactly the previous one, and no key is stored', async () => {
    reset(); const c = await seed(); const A = await instance(); const B = await instance();
    await analyze(A, c); await analyze(B, c); assert.equal(await uses(c), 3);
    assert.equal((await db.admin('select count(*)::int n from license_reservations where code=$1 and request_key is not null', [c])).rows[0].n, 0);
  });

  await t.test('MIGRATION MISSING: new code against a database without migration 03 answers a calm "try again" and charges nothing', async () => {
    reset(); const bare = await H.freshDatabase('rg_durable_bare');
    await bare.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(bare); await H.applyMigration(bare, H.MIG1); await H.applyMigration(bare, H.MIG2);
    const code = newCode(); await H.seed(bare, [{ code, uses: 5, assigned: true }]);
    const hs = loadHandlers(bare.pool('service_role', 5)); await hs.verify(post({ code: 'FG-ZZZZ-ZZZZ' })).catch(() => {});
    const cap = captureLogs(); let r; try { r = await analyze(hs, code, { requestId: 'req-analyze-0006' }); } finally { cap.restore(); }
    assert.equal(r.statusCode, 503); assert.equal((await bare.admin('select uses_remaining u from licenses where code=$1', [code])).rows[0].u, 5);
    assert.equal(ai.calls, 0);
    const old = await analyze(hs, code); assert.equal(old.statusCode, 200, 'without a request id the old call shape still works on the older database');
    await bare.close();
  });

  await db.close();
});
