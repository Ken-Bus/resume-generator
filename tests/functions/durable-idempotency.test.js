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
  const fault = { reserve: null, commit: null, finish: null };                       // fault injection: a function name -> throw once matched
  const faulty = (pool) => { const q = pool.query.bind(pool); pool.query = async (sql, p) => { for (const [k, re] of [['reserve', /reserve_license_use/], ['commit', /commit_license_use/], ['finish', /finish_redelivery/]]) if (fault[k] && re.test(sql)) throw Object.assign(new Error(`injected ${k} failure`), { code: '08006' }); return q(sql, p); }; return pool; };
  const instance = async () => { const hs = loadHandlers(faulty(db.pool('service_role', 10))); instances.push(hs); await hs.verify(post({ code: 'FG-ZZZZ-ZZZZ' })).catch(() => {}); return hs; };
  const seed = async (uses = 5) => { const c = newCode(); await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const uses = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const rsv = async (c) => (await db.admin('select status from license_reservations where code=$1 order by created_at', [c])).rows.map((x) => x.status);
  const reset = () => { ai.mode = 'ok'; ai.delayMs = 0; ai.calls = 0; ai.maxInflight = 0; ai.polishPayload = null; fault.reserve = fault.commit = fault.finish = null; };
  const age = (c, interval) => db.admin(`update license_reservations set committed_at = now() - interval '${interval}', created_at = now() - interval '${interval}' where code = '${c}' and status = 'committed'`);
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
    assert.equal(second.statusCode, 200); assert.equal(b.charged, true); assert.equal(JSON.parse(b.result).experience[0].bullets[0], FIXED[0]); assert.equal(b.recovered, 'regenerated'); assert.match(b.message, /may differ/);
    assert.equal(b.usesRemaining, 4); assert.equal(await uses(c), 4); assert.deepEqual(await rsv(c), ['committed']);
    const tailor = await B.tailor(post({ resumeData: JSON.parse(b.result), tailorToken: b.tailorToken, jobDescription: 'Retail clerk: cash handling and customer service.' }));
    assert.notEqual(tailor.statusCode, 401, 'the paid generation can still be tailored after a re-delivery');
  });

  await t.test('FINDING 1: another request id is a NEW operation (charged); the SAME id with edited text is REFUSED (nothing charged, no AI call) and a fresh id then works', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixAll; const A = await instance(); const B = await instance();
    await polish(A, c, { requestId: 'req-polish-0002' }); assert.equal(await uses(c), 4);
    await polish(B, c, { requestId: 'req-polish-0003' }); assert.equal(await uses(c), 3, 'another request id: another step');
    const edited = clone(RESUME); edited.experience[0].bullets = [...BASE.slice(0, 3), 'Answered questons about prices and returns'];
    ai.polishPayload = (r) => { const o = clone(r); o.experience[0].bullets = [FIXED[0], FIXED[1], FIXED[2], 'Answered questions about prices and returns']; return o; };
    ai.calls = 0; const clash = await polish(B, c, { requestId: 'req-polish-0002' }, edited); const cb = parseBody(clash);
    assert.equal(clash.statusCode, 409); assert.equal(cb.code, 'request_conflict'); assert.equal(cb.newRequest, true); assert.match(cb.error, /has changed since an earlier polish/); assert.match(cb.supportRef, /^R-[0-9A-F]{8}$/);
    assert.equal(ai.calls, 0, 'refused before any AI call'); assert.equal(await uses(c), 3, 'and before any charge');
    const same = await polish(A, c, { requestId: 'req-polish-0002' }, edited);                // the first instance too: its memory cannot serve the old result for new input
    assert.equal(same.statusCode, 409, 'a cache on the instance that did the original work does not serve stale output for edited input');
    const fresh = await polish(B, c, { requestId: 'req-polish-0009' }, edited); assert.equal(fresh.statusCode, 200); assert.equal(await uses(c), 2, 'the deliberate new operation is charged normally');
  });

  await t.test('FINDING 1: a stale tab resubmitting the earlier request (same id, same input) is recovered free, never charged; Analyze behaves the same', async () => {
    reset(); const c = await seed(); const A = await instance(); const B = await instance();
    await analyze(A, c, { requestId: 'req-stale-0001' }); assert.equal(await uses(c), 4);
    const stale = await analyze(B, c, { requestId: 'req-stale-0001' }); assert.equal(stale.statusCode, 200); assert.equal(parseBody(stale).recovered, 'regenerated'); assert.equal(await uses(c), 4);
    ai.calls = 0; const other = await analyze(B, c, { requestId: 'req-stale-0001', resumeText: `${TEXT} I also volunteered.` });
    assert.equal(other.statusCode, 409); assert.equal(parseBody(other).code, 'request_conflict'); assert.equal(ai.calls, 0); assert.equal(await uses(c), 4);
  });

  await t.test('FINDING 1: overlapping operations with one id: same input -> one runs, the other waits; different input -> the second is refused; one charge in total', async () => {
    reset(); const c = await seed(); const A = await instance(); const B = await instance(); ai.delayMs = 400;
    const [r1, r2] = await Promise.all([analyze(A, c, { requestId: 'req-over-0001' }), (async () => { await new Promise((x) => setTimeout(x, 100)); return analyze(B, c, { requestId: 'req-over-0001' }); })()]);
    assert.deepEqual([r1.statusCode, r2.statusCode], [200, 409]); assert.match(parseBody(r2).error, /already in progress/); assert.equal(ai.calls, 1); assert.equal(await uses(c), 4);
    ai.delayMs = 400; const d = await seed();
    const [x1, x2] = await Promise.all([analyze(A, d, { requestId: 'req-over-0002' }), (async () => { await new Promise((x) => setTimeout(x, 100)); return analyze(B, d, { requestId: 'req-over-0002', resumeText: `${TEXT} More.` }); })()]);
    assert.equal(x1.statusCode, 200); assert.equal(x2.statusCode, 409); assert.equal(parseBody(x2).code, 'request_conflict'); assert.equal(await uses(d), 4);
  });

  await t.test('FINDING 2: retention. A retry 2 hours later is still recovered; after 24 hours the id is refused as expired (no AI call, no charge, new id works); the input hash is erased', async () => {
    reset(); const c = await seed(); const A = await instance(); await analyze(A, c, { requestId: 'req-ret-0001' });
    await age(c, '2 hours'); const B = await instance();
    const late = await analyze(B, c, { requestId: 'req-ret-0001' }); assert.equal(late.statusCode, 200); assert.equal(parseBody(late).recovered, 'regenerated'); assert.equal(await uses(c), 4, 'past the old 60-minute window and still never charged');
    await age(c, '25 hours'); ai.calls = 0; const C = await instance();
    const old = await analyze(C, c, { requestId: 'req-ret-0001' }); const ob = parseBody(old);
    assert.equal(old.statusCode, 409); assert.equal(ob.code, 'request_expired'); assert.equal(ob.newRequest, true); assert.match(ob.error, /more than a day old/); assert.equal(ai.calls, 0); assert.equal(await uses(c), 4);
    const row = (await db.admin("select input_hash, request_key from license_reservations where code=$1 and status='committed'", [c])).rows[0];
    assert.equal(row.input_hash, null); assert.match(row.request_key, /^[0-9a-f]{64}$/);
    assert.equal((await analyze(C, c, { requestId: 'req-ret-0002' })).statusCode, 200); assert.equal(await uses(c), 3, 'a new id is a new, deliberate operation');
  });

  await t.test('FAULT: the re-delivery fails (AI outage) -> 502, nothing charged, its turn is given back so the NEXT retry can still be re-delivered', async () => {
    reset(); const c = await seed(); const A = await instance(); const B = await instance();
    await analyze(A, c, { requestId: 'req-analyze-0002' });
    ai.mode = 'http500'; const failed = await analyze(B, c, { requestId: 'req-analyze-0002' });
    assert.equal(failed.statusCode, 502); assert.equal(parseBody(failed).code, 'recovery_failed'); assert.match(parseBody(failed).error, /nothing more has been charged/); assert.match(parseBody(failed).supportRef, /^R-/); assert.equal(await uses(c), 4);
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

  await t.test('FINDING 4: LIMIT. After three finished re-deliveries the customer gets a plain message with a non-secret support reference (no access code), no AI call, no charge, and a way forward; an EXHAUSTED code still re-delivers', async () => {
    reset(); const c = await seed(1); const A = await instance();
    await analyze(A, c, { requestId: 'req-analyze-0004' }); assert.equal(await uses(c), 0);
    for (let i = 0; i < 3; i++) assert.equal((await analyze(await instance(), c, { requestId: 'req-analyze-0004' })).statusCode, 200);
    ai.calls = 0; const last = await analyze(await instance(), c, { requestId: 'req-analyze-0004' }); const lb = parseBody(last);
    assert.equal(last.statusCode, 409); assert.equal(lb.code, 'recovery_limit'); assert.equal(lb.newRequest, true); assert.match(lb.supportRef, /^R-[0-9A-F]{8}$/);
    assert.match(lb.error, new RegExp(lb.supportRef)); assert.match(lb.error, /never your access code/); assert.equal(lb.error.includes(c), false); assert.equal(ai.calls, 0); assert.equal(await uses(c), 0);
    const id = (await db.admin("select id from license_reservations where code=$1 and status='committed'", [c])).rows[0].id; assert.equal(lb.supportRef, `R-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`, 'the owner can find the step from the reference');
  });

  await t.test('FINDING 4: an abandoned recovery (the worker died mid-recovery) does not abandon the customer: after its lease lapses the retry recovers, and the lapse is forgiven', async () => {
    reset(); const c = await seed(); const A = await instance(); await analyze(A, c, { requestId: 'req-lease-0001' });
    for (let i = 0; i < 3; i++) {
      await db.admin("update license_reservations set redelivering_until = now() + interval '30 seconds', redelivery_count = redelivery_count + 1 where code=$1 and status='committed'", [c]);   // a recovery started and its worker died
      assert.equal((await analyze(await instance(), c, { requestId: 'req-lease-0001' })).statusCode, 409, 'while the lease is live the retry waits');
      await db.admin("update license_reservations set redelivering_until = now() - interval '1 second' where code=$1 and status='committed'", [c]);
    }
    const ok = await analyze(await instance(), c, { requestId: 'req-lease-0001' }); assert.equal(ok.statusCode, 200, 'recovered after the lapses'); assert.equal(await uses(c), 4);
  });

  await t.test('FAULT INJECTION: database errors during reserve, commit and recovery never charge twice and never lose the paid step', async () => {
    reset(); const c = await seed(); const A = await instance();
    fault.commit = true; const lost = await analyze(A, c, { requestId: 'req-fault-0001' }); fault.commit = null;                  // the charge could not be recorded
    assert.equal(lost.statusCode, 503); assert.equal(await uses(c), 5, 'nothing charged when the charge was not recorded');
    assert.equal((await analyze(A, c, { requestId: 'req-fault-0001' })).statusCode, 200); assert.equal(await uses(c), 4, 'the retry of an UNcommitted step is an ordinary step: charged once');
    const B = await instance(); fault.reserve = true; const down = await analyze(B, c, { requestId: 'req-fault-0001' }); fault.reserve = null;
    assert.equal(down.statusCode, 503); assert.equal(await uses(c), 4, 'database down during a retry: calm message, nothing changes');
    fault.finish = true; const noFinish = await analyze(B, c, { requestId: 'req-fault-0001' }); fault.finish = null;                  // result produced, but freeing the recovery slot failed
    assert.equal(noFinish.statusCode, 200); assert.equal(await uses(c), 4);
    assert.equal((await analyze(B, c, { requestId: 'req-fault-0001' })).statusCode, 409, 'the stuck slot blocks only until its lease lapses');
    await db.admin("update license_reservations set redelivering_until = now() - interval '1 second' where code=$1 and status='committed'", [c]);
    assert.equal((await analyze(B, c, { requestId: 'req-fault-0001' })).statusCode, 200); assert.equal(await uses(c), 4);
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

  await t.test('PROVIDER BUSY (429 / 529): a calm "very busy, wait a minute" message on Analyze and Polish, nothing charged, not counted as the customer\'s failure, and no automatic retry', async () => {
    reset(); const c = await seed(); const A = await instance(); ai.polishPayload = fixAll;
    for (const mode of ['http429', 'http529']) {
      ai.mode = mode; ai.calls = 0;
      const a = await analyze(A, c); const p = await polish(A, c);
      for (const r of [a, p]) { assert.equal(r.statusCode, 502); assert.match(parseBody(r).error, /very busy/); assert.match(parseBody(r).error, /haven’t been charged/); }
      assert.equal(ai.calls, 2, 'exactly one provider call per request: the server never retries on its own');
    }
    assert.equal(await uses(c), 5); assert.ok((await rsv(c)).every((s) => s === 'released'));
    assert.equal((await db.admin("select count(*)::int n from license_reservations where code=$1 and failure_counted", [c])).rows[0].n, 0, 'an outage never counts against the customer');
  });

  await t.test('SECURITY: a request id is only ever honoured for the SAME code: another code (or an unknown one) cannot replay or read someone else\'s paid step', async () => {
    reset(); const owner = await seed(); const other = await seed(); const A = await instance(); const B = await instance();
    await analyze(A, owner, { requestId: 'req-analyze-0007' }); assert.equal(await uses(owner), 4);
    const mine = await analyze(B, other, { requestId: 'req-analyze-0007' });                         // same id, same text, different customer
    assert.equal(mine.statusCode, 200); assert.equal(await uses(other), 4, 'charged as its own new step, not replayed from the other code');
    ai.calls = 0; const stranger = await analyze(B, 'FG-NONE-NONE', { requestId: 'req-analyze-0007' });
    assert.equal(stranger.statusCode, 403); assert.equal(ai.calls, 0); assert.equal(await uses(owner), 4);
  });

  await t.test('RE-DELIVERY is never turned into a "free, nothing changed" reply: the step was paid, so even a lighter second answer is delivered (and still uncharged)', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixAll; const A = await instance(); const B = await instance();
    await polish(A, c, { requestId: 'req-polish-0005' }); assert.equal(await uses(c), 4);
    ai.polishPayload = (r) => r;                                                         // the second run happens to find nothing to change
    const again = await polish(B, c, { requestId: 'req-polish-0005' }); const b = parseBody(again);
    assert.equal(again.statusCode, 200); assert.equal(b.charged, true); assert.ok(b.result); assert.notEqual(b.noChange, true); assert.equal(await uses(c), 4);
  });

  await t.test('FINDING 3: the AI is busy (429/529) or fails DURING a recovery: honest message, nothing charged, its turn is given back; recovered wording is labelled regenerated, an on-instance repeat is labelled exact and costs no AI call', async () => {
    reset(); const c = await seed(); const A = await instance(); const B = await instance(); await analyze(A, c, { requestId: 'req-rec-0001' });
    ai.mode = 'http529'; const busy = parseBody(await analyze(B, c, { requestId: 'req-rec-0001' }));
    assert.equal(busy.code, 'recovery_failed'); assert.match(busy.error, /very busy/); assert.match(busy.error, /completed and counted/); assert.equal(await uses(c), 4);
    ai.mode = 'notjson'; const bad = parseBody(await analyze(B, c, { requestId: 'req-rec-0001' })); assert.equal(bad.code, 'recovery_failed'); assert.equal(await uses(c), 4);
    ai.mode = 'ok'; const good = parseBody(await analyze(B, c, { requestId: 'req-rec-0001' }));
    assert.equal(good.recovered, 'regenerated'); assert.match(good.message, /fresh version/); assert.match(good.message, /may differ/); assert.match(good.message, /No additional generation was used/);
    assert.equal((await db.admin("select redelivery_count n from license_reservations where code=$1 and status='committed'", [c])).rows[0].n, 1, 'two failed recoveries gave their turns back');
    ai.calls = 0; const exact = parseBody(await analyze(A, c, { requestId: 'req-rec-0001' }));
    assert.equal(exact.recovered, 'exact'); assert.match(exact.message, /exactly as it was/); assert.equal(ai.calls, 0, 'the instance that did the work answers from memory: no AI call'); assert.equal(await uses(c), 4);
  });

  await t.test('free polish + the same id with edited text: a FREE result is not a paid step, so the edit is an ordinary new request (free or charged on its own merits)', async () => {
    reset(); const c = await seed(); const A = await instance(); ai.polishPayload = (r) => { const o = clone(r); o.experience[0].bullets[0] = FIXED[0]; return o; };
    const free = parseBody(await polish(A, c, { requestId: 'req-free-0001' })); assert.equal(free.charged, false);
    ai.polishPayload = fixAll; const edited = clone(RESUME); edited.experience[0].bullets = [...BASE.slice(0, 3), 'Answered questons about prices and returns'];
    const r = await polish(await instance(), c, { requestId: 'req-free-0001' }, edited); assert.equal(r.statusCode, 200); assert.equal(await uses(c), 4, 'charged only because this edit really earned a generation');
  });

  await t.test('UNAUTHORIZED ROLES: a browser role (anon / authenticated) cannot call any reservation function or read the reservation table, with a real attempt, not only a catalog check', async () => {
    const c = await seed(); await analyze(await instance(), c, { requestId: 'req-priv-0001' });
    for (const role of ['anon', 'authenticated']) {
      const pool = db.pool(role, 2);
      for (const sql of ["select * from public.reserve_license_use('" + c + "',45,900,6,30,'k','h')", "select public.finish_redelivery(gen_random_uuid(), true)", 'select public.purge_idempotency_hashes()', 'select * from license_reservations', "update licenses set uses_remaining = 99 where code = '" + c + "'", 'select code, uses_remaining from licenses'])
        await assert.rejects(() => pool.query(sql), /permission denied|row-level security|must be owner/i, `${role}: ${sql.slice(0, 50)}`);
      await pool.end();
    }
    assert.equal(await uses(c), 4);
  });

  await t.test('PRIVACY / RETENTION: the stored values are KEYED hashes (not reproducible without the server secret) and the daily housekeeping function erases old input hashes', async () => {
    reset(); const c = await seed(); const A = await instance(); await analyze(A, c, { requestId: 'req-hmac-0001' });
    const row = (await db.admin("select request_key, input_hash from license_reservations where code=$1 and status='committed'", [c])).rows[0];
    const crypto = require('crypto'); const plain = (v) => crypto.createHash('sha256').update(v).digest('hex');
    assert.notEqual(row.request_key, plain('key:analyze:req-hmac-0001'), 'not a plain hash of the id'); assert.notEqual(row.input_hash, plain(`in:${TEXT}`), 'not a plain hash of the resume text');
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
