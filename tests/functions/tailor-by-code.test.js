// Tailoring authorised by the ACCESS CODE (migration 06), through the real handlers and real SQL (AI provider mocked). Only the new path is covered here;
// the token path, the failure budget, privacy of logs and the 5-run cap keep their existing suites (endpoints, release-matrix, integrity), which run on a
// database that has migration 06 applied, so they also prove the old behaviour is unchanged on top of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, loadHandlers, post, parseBody, installAi, captureLogs, GOOD_RESUME } = require('./harness');

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const RESUME_TEXT = 'Jordan Ellis — Retail Associate at Fictional Maple Market, 2023-2026. Customer service, basic Excel.';
const JOB = 'Administrative assistant: manage calendars, Excel.';
let seq = 0; const newCode = () => `FG-B${String(++seq).padStart(3, '0')}-TTTT`;

test('tailoring by access code: a code uses only its own runs, 5 per paid step, through the 96-hour period, refused after (real SQL)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_tbc'); await db.admin(H.SUPABASE_DEFAULT_PRIVS);
  await H.liveState(db); for (const m of [H.MIG1, H.MIG2, H.MIG3, H.MIG4]) await H.applyMigration(db, m);       // the harness adds migrations 05 and 06 after 04
  const pool = db.pool('service_role', 40); const hs = loadHandlers(pool); const ai = installAi({});
  process.env.SUPABASE_URL = 'http://mock.invalid'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-not-a-real-key'; process.env.ANTHROPIC_API_KEY = 'mock-not-a-real-key';
  process.env.TAILOR_TOKEN_SECRET = SECRET; process.env.AI_TIMEOUT_MS = '1000';
  const tailorMod = require(hs.FUNCS + '/tailor-resume');
  const reset = () => { ai.mode = 'ok'; ai.delayMs = 0; ai.calls = 0; process.env.TAILOR_TOKEN_SECRET = SECRET; tailorMod._failedChecks.reset && tailorMod._failedChecks.reset(); };

  const seed = async () => { const c = newCode(); await H.seed(db, [{ code: c, uses: 5, assigned: true }]); return c; };
  const analyze = async (c) => { const b = parseBody(await hs.parse(post({ code: c, resumeText: RESUME_TEXT }))); return { token: b.tailorToken, rid: hs.tokens.verify(SECRET, b.tailorToken).reservationId }; };
  const tailor = (code, extra = {}) => hs.tailor(post({ resumeData: GOOD_RESUME, jobDescription: JOB, code, ...extra }));
  const count = async (id) => (await db.admin('select tailor_count c from license_reservations where id=$1', [id])).rows[0].c;
  const balance = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  // Use up the included Polish (a committed Polish row linked to the Analyze) and the balance, then move the last paid step `hours` hours into the past.
  const closeCode = async (c, rid, hours) => {
    const p = (await db.admin(`insert into license_reservations(code,status,expires_at,committed_at,kind,included_from) values ($1,'committed',now()+interval '1 hour',now(),'polish',$2) returning id`, [c, rid])).rows[0].id;
    await db.admin('update license_reservations set included_polish_by=$2 where id=$1', [rid, p]);
    await db.admin(`update license_reservations set committed_at = now() - make_interval(hours => $2) where code=$1`, [c, hours]);
    await db.admin('update licenses set uses_remaining = 0 where code=$1', [c]);
  };

  await t.test('a valid code tailors with NO token, NO tailoring secret, no generation used; the page is told how many runs are left', async () => {
    reset(); const c = await seed(); const { rid } = await analyze(c); delete process.env.TAILOR_TOKEN_SECRET; const bal = await balance(c); ai.calls = 0;
    const r = await tailor(c); const b = parseBody(r);
    assert.equal(r.statusCode, 200); assert.equal(b.tailorRunsRemaining, 4); assert.equal(b.tailorRunsAvailable, 4);
    assert.equal(await balance(c), bal); assert.equal(await count(rid), 1); assert.equal(ai.calls, 1);
  });

  await t.test('a break or a new day changes nothing: an expired token is ignored when the code is sent, and the page learns the runs at sign-in', async () => {
    reset(); const c = await seed(); const { rid } = await analyze(c);
    const stale = hs.tokens.sign(SECRET, rid, 600, Date.now() - 48 * 3600 * 1000);                 // issued two days ago
    assert.equal((await tailor(c, { tailorToken: stale })).statusCode, 200);
    const v = parseBody(await hs.verify(post({ code: c }))); assert.equal(v.valid, true); assert.equal(v.tailorRunsAvailable, 4);
    assert.equal(parseBody(await hs.verify(post({ code: await seed() }))).tailorRunsAvailable, 0, 'a code with no paid step has none');
  });

  await t.test('OWN RUNS ONLY: another code, with or without a paid step, can neither spend nor change them; a foreign token does not redirect the run', async () => {
    reset(); const a = await seed(), b = await seed(), empty = await seed(); const ra = await analyze(a); const rb = await analyze(b); ai.calls = 0;
    assert.equal((await tailor(empty)).statusCode, 401); assert.equal(ai.calls, 0, 'no paid step => nothing to tailor with, no AI call');
    const foreign = hs.tokens.sign(SECRET, rb.rid, 600);
    assert.equal((await tailor(a, { tailorToken: foreign })).statusCode, 200);
    assert.equal(await count(ra.rid), 1); assert.equal(await count(rb.rid), 0, 'the other code\'s step was not used');
    assert.equal((await tailor('FG-ZZZZ-9999')).statusCode, 401); assert.match(parseBody(await tailor('FG-ZZZZ-9999')).error, /couldn’t find/);
  });

  await t.test('FIVE runs per paid step: the sixth is refused with the exact AI-call count; a second paid step brings five more', async () => {
    reset(); const c = await seed(); const first = await analyze(c); ai.calls = 0;
    for (let i = 1; i <= 5; i++) assert.equal(parseBody(await tailor(c)).tailorRunsAvailable, 5 - i);
    const r6 = await tailor(c); assert.equal(r6.statusCode, 429); assert.equal(parseBody(r6).tailorRunsAvailable, 0); assert.equal(ai.calls, 5); assert.equal(await count(first.rid), 5);
    const second = await analyze(c); ai.calls = 0;
    assert.equal(parseBody(await hs.verify(post({ code: c }))).tailorRunsAvailable, 5);
    for (let i = 0; i < 5; i++) assert.equal((await tailor(c)).statusCode, 200);
    assert.equal((await tailor(c)).statusCode, 429); assert.equal(await count(second.rid), 5); assert.equal(await count(first.rid), 5);
  });

  await t.test('PARALLEL: 20 simultaneous requests on one code => exactly 5 AI calls and 5 successes', async () => {
    reset(); const c = await seed(); await analyze(c); ai.calls = 0; ai.delayMs = 80;
    const rs = await Promise.all(Array.from({ length: 20 }, () => tailor(c)));
    assert.equal(rs.filter((r) => r.statusCode === 200).length, 5); assert.equal(rs.filter((r) => r.statusCode === 429).length, 15); assert.equal(ai.calls, 5);
  });

  await t.test('96-HOUR COMPLETION PERIOD: no generations and no included Polish left, tailoring still works', async () => {
    reset(); const c = await seed(); const { rid } = await analyze(c); await closeCode(c, rid, 30);
    assert.equal(parseBody(await hs.verify(post({ code: c }))).accessState, 'completion');
    const r = await tailor(c); assert.equal(r.statusCode, 200); assert.equal(await balance(c), 0, 'still no generation, none used');
  });

  await t.test('AFTER ACCESS ENDS: refused with 403 and the ended header, ZERO AI calls, no run used; sign-in refuses too', async () => {
    reset(); const c = await seed(); const { rid } = await analyze(c); await closeCode(c, rid, 97); ai.calls = 0;
    const r = await tailor(c); assert.equal(r.statusCode, 403); assert.equal(r.headers['X-Access-State'], 'ended'); assert.match(parseBody(r).error, /four-day finishing period/);
    assert.equal(ai.calls, 0); assert.equal(await count(rid), 0);
    assert.equal(parseBody(await hs.verify(post({ code: c }))).accessState, 'ended');
    const withToken = await tailor(c, { tailorToken: hs.tokens.sign(SECRET, rid, 600) }); assert.equal(withToken.statusCode, 403, 'a still-valid token does not reopen an ended code'); assert.equal(ai.calls, 0);
  });

  await t.test('an unused included Polish keeps the code active however long ago the Analyze was, so its runs are still there', async () => {
    reset(); const c = await seed(); const { rid } = await analyze(c);
    await db.admin(`update license_reservations set committed_at = now() - interval '200 days' where id=$1`, [rid]); await db.admin('update licenses set uses_remaining = 0 where code=$1', [c]);
    assert.equal(parseBody(await hs.verify(post({ code: c }))).accessState, 'active'); assert.equal((await tailor(c)).statusCode, 200);
  });

  await t.test('an AI failure gives the run back to the SAME step; bad input is refused before any run is used', async () => {
    reset(); const c = await seed(); const { rid } = await analyze(c); ai.mode = 'http500';
    assert.equal((await tailor(c)).statusCode, 502); assert.equal(await count(rid), 0);
    ai.mode = 'ok'; ai.calls = 0;
    for (const extra of [{ jobDescription: '' }, { jobDescription: 'x'.repeat(10001) }, { resumeData: 'nope' }, { resumeData: { name: 'x'.repeat(70000) } }]) { const r = await tailor(c, extra); assert.ok([400, 413].includes(r.statusCode)); }
    assert.equal((await tailor(c, { clientGuard: 'old-version' })).statusCode, 409);
    assert.equal(ai.calls, 0); assert.equal(await count(rid), 0);
  });

  await t.test('malformed codes are refused before the database, and guessing is rate limited per client', async () => {
    reset(); ai.calls = 0;
    for (const bad of ['nope', 'FG-12-34', 'fg-a1b2-c3d4x']) { const r = await tailor(bad); assert.equal(r.statusCode, 400); }
    for (let i = 0; i < 30; i++) await tailor('nope');
    const r = await tailor('nope'); assert.equal(r.statusCode, 429); assert.ok(r.headers['Retry-After']); assert.equal(ai.calls, 0);
    reset();
  });

  await t.test('migration 06 not applied yet: tailoring falls back to the token path unchanged, and without a valid token uses nothing', async () => {
    reset(); const c = await seed(); const { token, rid } = await analyze(c); const real = hs.license.tailorAuthorizeForCode;
    hs.license.tailorAuthorizeForCode = async () => null;
    try {
      assert.equal((await tailor(c, { tailorToken: token })).statusCode, 200); assert.equal(await count(rid), 1);
      ai.calls = 0; assert.equal((await tailor(c)).statusCode, 401); assert.equal((await tailor(c, { tailorToken: 'garbage' })).statusCode, 401);
      delete process.env.TAILOR_TOKEN_SECRET; assert.equal((await tailor(c)).statusCode, 503); assert.equal(ai.calls, 0); assert.equal(await count(rid), 1);
    } finally { hs.license.tailorAuthorizeForCode = real; reset(); }
  });

  await t.test('privacy: failures and logs never contain the access code or the resume text', async () => {
    reset(); const c = await seed(); await analyze(c); const logs = captureLogs();
    ai.mode = 'throw'; const r1 = await tailor(c); ai.mode = 'ok';
    const real = hs.license.tailorAuthorizeForCode; hs.license.tailorAuthorizeForCode = async () => { throw new Error(`SECRET_INTERNAL_DETAIL ${c}`); };
    const r2 = await tailor(c); hs.license.tailorAuthorizeForCode = real; logs.restore();
    const all = logs.lines.join('\n') + r1.body + r2.body;
    assert.ok(!all.includes(c), 'no access code'); assert.ok(!/Jordan Ellis|Maple Market|SECRET_INTERNAL_DETAIL/.test(all), 'no resume text or internal detail'); assert.equal(r2.statusCode, 503);
  });

  t.after(async () => { await db.close(); });
});
