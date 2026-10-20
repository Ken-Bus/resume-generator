const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { H, loadHandlers, post, sleep, parseBody, installAi, captureLogs, GOOD_RESUME, FUNCS } = require('./harness');

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const RESUME_TEXT = 'Jordan Ellis — Retail Associate at Fictional Maple Market, 2023-2026. Customer service, basic Excel.';
let seq = 0;
const newCode = () => `FG-T${String(++seq).padStart(3, '0')}-AAAA`;

test('Netlify functions against real SQL (AI provider mocked)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }

  const db = await H.freshDatabase('rg_fn');
  await db.admin(H.SUPABASE_DEFAULT_PRIVS);
  await H.liveState(db); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2);
  await H.seed(db, [{ code: 'FG-CUST-0001', uses: 3, assigned: true, buyer: 'customer@example.com' }]);
  const pool = db.pool('service_role', 40);
  const hs = loadHandlers(pool);
  const ai = installAi({});
  process.env.SUPABASE_URL = 'http://mock.invalid'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-not-a-real-key';
  process.env.ANTHROPIC_API_KEY = 'mock-not-a-real-key';
  process.env.TAILOR_TOKEN_SECRET = SECRET;
  process.env.AI_TIMEOUT_MS = '1000';

  const seed = async (uses = 5) => { const c = newCode(); await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const uses = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const rsv = async (c) => (await db.admin('select status, tailor_count from license_reservations where code=$1 order by created_at', [c])).rows;
  const callParse = (code, text = RESUME_TEXT) => hs.parse(post({ code, resumeText: text }));
  const reset = () => { ai.mode = 'ok'; ai.delayMs = 0; ai.calls = 0; process.env.TAILOR_TOKEN_SECRET = SECRET; process.env.AI_TIMEOUT_MS = '1000'; };

  // ---------------- parse-resume: authorisation happens before any billable AI call ----------------
  await t.test('parse: no code / malformed / unknown / exhausted => rejected with ZERO AI calls', async () => {
    reset();
    const ex = await seed(0);
    const cases = [
      [{ resumeText: RESUME_TEXT }, 401], [{ code: '', resumeText: RESUME_TEXT }, 401], [{ code: 12345, resumeText: RESUME_TEXT }, 401],
      [{ code: 'nope', resumeText: RESUME_TEXT }, 400], [{ code: 'FG-ZZZZ-9999', resumeText: RESUME_TEXT }, 403], [{ code: ex, resumeText: RESUME_TEXT }, 403],
    ];
    for (const [body, status] of cases) { const r = await hs.parse(post(body)); assert.equal(r.statusCode, status, JSON.stringify(body)); assert.ok(parseBody(r).error); }
    assert.equal(ai.calls, 0);
    assert.equal(parseBody(await callParse(ex)).error, 'You’ve used all generations on this code.');
  });

  await t.test('parse: method and body validation', async () => {
    reset();
    assert.equal((await hs.parse({ httpMethod: 'GET' })).statusCode, 405);
    assert.equal((await hs.parse(post('{bad'))).statusCode, 400);
    assert.equal((await hs.parse(post('[]'))).statusCode, 400);
    const c = await seed();
    assert.equal((await hs.parse(post({ code: c, resumeText: '   ' }))).statusCode, 400);
    assert.equal(ai.calls, 0); assert.equal((await rsv(c)).length, 0);
  });

  await t.test('parse: input limits => 413 before reservation or AI', async () => {
    reset(); const c = await seed();
    assert.equal((await callParse(c, 'x'.repeat(30001))).statusCode, 413);
    assert.equal((await hs.parse(post({ code: c, resumeText: 'x'.repeat(300000) }))).statusCode, 413);
    assert.equal(ai.calls, 0); assert.equal((await rsv(c)).length, 0); assert.equal(await uses(c), 5);
    assert.equal((await callParse(c, 'x'.repeat(30000))).statusCode, 200);   // exactly at the limit is fine
  });

  await t.test('parse: success charges exactly one use and returns result, counts and a tailoring token', async () => {
    reset(); const c = await seed();
    const r = await callParse(c); const b = parseBody(r);
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(b.result).name, 'Jordan Ellis');
    assert.equal(b.usesRemaining, 4); assert.equal(b.maxUses, 5); assert.ok(b.tailorToken);
    assert.equal(await uses(c), 4); assert.deepEqual((await rsv(c)).map(x => x.status), ['committed']);
    assert.equal(ai.calls, 1);
  });

  for (const mode of ['http500', 'throw', 'truncated', 'notjson', 'badshape', 'empty']) {
    await t.test(`parse: AI failure (${mode}) => 502, reservation released, customer NOT charged`, async () => {
      reset(); const c = await seed(); ai.mode = mode;
      const r = await callParse(c);
      assert.equal(r.statusCode, 502);
      assert.match(parseBody(r).error, /haven’t been charged/);
      assert.equal(await uses(c), 5); assert.deepEqual((await rsv(c)).map(x => x.status), ['released']);
      ai.mode = 'ok'; assert.equal((await callParse(c)).statusCode, 200);      // and the customer can simply retry
      assert.equal(await uses(c), 4);
    });
  }

  await t.test('parse: AI timeout => 502, aborted, released, NOT charged', async () => {
    reset(); const c = await seed(); ai.mode = 'hang';
    const started = Date.now(); const r = await callParse(c);
    assert.equal(r.statusCode, 502); assert.ok(Date.now() - started < 4000);
    assert.equal(await uses(c), 5); assert.deepEqual((await rsv(c)).map(x => x.status), ['released']);
  });

  await t.test('CONCURRENCY: 12 simultaneous valid requests on a 5-use code => exactly 5 succeed, 5 AI calls, never a 6th', async () => {
    reset(); const c = await seed(); ai.delayMs = 150;
    const rs = await Promise.all(Array.from({ length: 12 }, () => callParse(c)));
    const codes = rs.map(r => r.statusCode);
    assert.equal(codes.filter(x => x === 200).length, 5);
    assert.equal(codes.filter(x => x === 409).length, 7);
    assert.equal(ai.calls, 5);                                   // blocked requests never reach the AI
    assert.equal(await uses(c), 0);
    ai.delayMs = 0; assert.equal((await callParse(c)).statusCode, 403);
    assert.equal(ai.calls, 5);
  });

  await t.test('CONCURRENCY: 10 simultaneous requests with ONE use left => one success, nine "busy", one AI call', async () => {
    reset(); const c = await seed(1); ai.delayMs = 150;
    const rs = await Promise.all(Array.from({ length: 10 }, () => callParse(c)));
    assert.equal(rs.filter(r => r.statusCode === 200).length, 1);
    assert.equal(rs.filter(r => r.statusCode === 409).length, 9);
    assert.match(parseBody(rs.find(r => r.statusCode === 409)).error, /already in progress/);
    assert.equal(ai.calls, 1); assert.equal(await uses(c), 0);
  });

  await t.test('CRASH: a worker that dies after reserving leaks nothing — uses unchanged, lease expires, customer can retry', async () => {
    reset(); const c = await seed(1); ai.mode = 'throw';
    const realRelease = hs.license.safeRelease;
    hs.license.safeRelease = async () => {};                      // "process killed" before it could release
    assert.equal((await callParse(c)).statusCode, 502);
    hs.license.safeRelease = realRelease; ai.mode = 'ok';
    assert.deepEqual((await rsv(c)).map(x => x.status), ['reserved']);       // leaked lease...
    assert.equal(await uses(c), 1);                                          // ...but the customer was never charged
    assert.equal((await callParse(c)).statusCode, 409);                      // still within the lease: protected from double-booking
    await db.admin(`update license_reservations set expires_at = now() - interval '1 second' where code=$1`, [c]);
    const r = await callParse(c);
    assert.equal(r.statusCode, 200); assert.equal(await uses(c), 0);          // lease lapsed on its own
  });

  await t.test('commit retries safely: one transient commit failure still charges exactly once', async () => {
    reset(); const c = await seed(); const realCommit = hs.license.commit; let n = 0;
    hs.license.commit = async (...a) => { if (n++ === 0) { await realCommit(...a); throw new Error('response lost'); } return realCommit(...a); };
    const r = await callParse(c); hs.license.commit = realCommit;
    assert.equal(r.statusCode, 200); assert.equal(await uses(c), 4);        // landed once, retried idempotently
  });

  await t.test('commit failing twice => 503, released, not charged', async () => {
    reset(); const c = await seed(); const realCommit = hs.license.commit;
    hs.license.commit = async () => { throw new Error('db down'); };
    const r = await callParse(c); hs.license.commit = realCommit;
    assert.equal(r.statusCode, 503); assert.equal(await uses(c), 5); assert.deepEqual((await rsv(c)).map(x => x.status), ['released']);
  });

  await t.test('database unavailable => 503 with ZERO AI calls', async () => {
    reset();
    const bad = loadHandlers({ query: async () => { throw new Error('connection refused'); } });
    const r = await bad.parse(post({ code: 'FG-ZZZZ-9999', resumeText: RESUME_TEXT }));
    assert.equal(r.statusCode, 503); assert.equal(ai.calls, 0);
    loadHandlers(pool);
  });

  await t.test('release-order safety: code deployed before migration 01 fails closed (503, zero AI calls, uncharged) with an explicit log line', async () => {
    reset(); const c = await seed(); const real = hs.license.reserve;
    hs.license.reserve = async () => { throw Object.assign(new Error('Could not find the function public.reserve_license_use'), { code: 'PGRST202' }); };
    const logs = captureLogs(); const r = await callParse(c); logs.restore(); hs.license.reserve = real;
    assert.equal(r.statusCode, 503); assert.equal(ai.calls, 0); assert.equal(await uses(c), 5);
    assert.ok(logs.lines.some(l => /migrations\/20261020_01_license_reservations\.sql/.test(l)));
  });

  await t.test('missing AI key => generic 500; missing/short tailoring secret never blocks the paid analysis', async () => {
    reset(); const c = await seed();
    const key = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    assert.equal((await callParse(c)).statusCode, 500); process.env.ANTHROPIC_API_KEY = key;
    delete process.env.TAILOR_TOKEN_SECRET;
    const logs = captureLogs(); const r = await callParse(c); logs.restore();
    assert.equal(r.statusCode, 200); assert.equal(parseBody(r).tailorToken, null);
    assert.ok(logs.lines.some(l => /TAILOR_TOKEN_SECRET/.test(l)));
    process.env.TAILOR_TOKEN_SECRET = 'short'; assert.equal(parseBody(await callParse(c)).tailorToken, null);
  });

  await t.test('privacy: failure responses and logs never contain the license code, resume text or internal error detail', async () => {
    reset(); const c = await seed(); const logs = captureLogs();
    ai.mode = 'throw'; const r1 = await callParse(c);
    ai.mode = 'ok'; const realCommit = hs.license.commit; hs.license.commit = async () => { throw new Error('SECRET_INTERNAL_DETAIL'); };
    const r2 = await callParse(c); hs.license.commit = realCommit; logs.restore();
    for (const r of [r1, r2]) for (const needle of [c, 'Jordan', 'Maple', 'SECRET_INTERNAL_DETAIL', 'socket hang up']) assert.ok(!r.body.includes(needle), `response leaked ${needle}`);
    for (const l of logs.lines) for (const needle of [c, 'Jordan', 'Maple']) assert.ok(!l.includes(needle), `log leaked ${needle}: ${l}`);
  });

  await t.test('existing customer mid-way keeps their balance, finishes it, then is cleanly blocked', async () => {
    reset();
    for (let i = 3; i >= 1; i--) { const b = parseBody(await callParse('FG-CUST-0001')); assert.equal(b.usesRemaining, i - 1); }
    assert.equal((await callParse('FG-CUST-0001')).statusCode, 403);
    const row = (await db.admin(`select buyer_email, assigned from licenses where code='FG-CUST-0001'`)).rows[0];
    assert.deepEqual(row, { buyer_email: 'customer@example.com', assigned: true });
  });

  // ---------------- tailor-resume: signed, short-lived, bound to a paid generation, capped ----------------
  const paid = async () => { const c = await seed(); const b = parseBody(await callParse(c)); return { c, token: b.tailorToken, rid: hs.tokens.verify(SECRET, b.tailorToken).reservationId }; };
  const callTailor = (token, extra = {}) => hs.tailor(post({ resumeData: GOOD_RESUME, jobDescription: 'Administrative assistant: manage calendars, Excel.', tailorToken: token, ...extra }));

  await t.test('tailor: no / garbage / tampered / wrong-secret / expired / unknown-reservation / unpaid-reservation tokens => 401 with ZERO AI calls', async () => {
    reset(); const { token, rid } = await paid(); ai.calls = 0;
    const flip = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    const forged = hs.tokens.sign('another-secret-another-secret-another-secret-xx', rid, 600);
    const expired = hs.tokens.sign(SECRET, rid, 600, Date.now() - 3 * 3600 * 1000);
    const ghost = hs.tokens.sign(SECRET, '11111111-1111-4111-8111-111111111111', 600);
    const c2 = await seed(); const unpaid = (await db.admin(`select * from public.reserve_license_use($1,45)`, [c2])).rows[0];
    const unpaidTok = hs.tokens.sign(SECRET, unpaid.reservation_id, 600);
    for (const bad of [undefined, '', 'garbage', 'a.b', flip, forged, expired, ghost, unpaidTok, token + 'x']) {
      const r = await callTailor(bad); assert.equal(r.statusCode, 401, String(bad)); 
    }
    assert.equal(ai.calls, 0);
    assert.match(parseBody(await callTailor(undefined)).error, /Analyze your resume/);
    assert.match(parseBody(await callTailor(expired)).error, /expired/);
  });

  await t.test('tailor: valid token => 200, consumes NO generation, token carries no license code', async () => {
    reset(); const { c, token } = await paid(); const before = await uses(c);
    const r = await callTailor(token); const b = parseBody(r);
    assert.equal(r.statusCode, 200); assert.ok(JSON.parse(b.result).matchSummary.missingKeywords.includes('Salesforce'));
    assert.equal(await uses(c), before);
    const payload = Buffer.from(token.split('.')[0], 'base64url').toString();
    assert.ok(!payload.includes(c)); assert.ok(JSON.parse(payload).exp > Date.now() / 1000);
  });

  await t.test('tailor: replay protection — 20 simultaneous replays of one token => exactly 5 run, exactly 5 AI calls', async () => {
    reset(); const { token } = await paid(); ai.calls = 0; ai.delayMs = 100;
    const rs = await Promise.all(Array.from({ length: 20 }, () => callTailor(token)));
    assert.equal(rs.filter(r => r.statusCode === 200).length, 5);
    assert.equal(rs.filter(r => r.statusCode === 429).length, 15);
    assert.equal(ai.calls, 5);
  });

  await t.test('tailor: allowance is per paid generation (another paid generation has its own)', async () => {
    reset(); const a = await paid(), b = await paid();
    for (let i = 0; i < 5; i++) assert.equal((await callTailor(a.token)).statusCode, 200);
    assert.equal((await callTailor(a.token)).statusCode, 429);
    assert.equal((await callTailor(b.token)).statusCode, 200);
  });

  await t.test('tailor: AI failure gives the run back', async () => {
    reset(); const { rid, token } = await paid(); ai.mode = 'http500';
    assert.equal((await callTailor(token)).statusCode, 502);
    assert.equal((await db.admin('select tailor_count from license_reservations where id=$1', [rid])).rows[0].tailor_count, 0);
    ai.mode = 'truncated'; assert.equal((await callTailor(token)).statusCode, 502);
    assert.equal((await db.admin('select tailor_count from license_reservations where id=$1', [rid])).rows[0].tailor_count, 0);
  });

  await t.test('tailor: input validation and disabled-secret behaviour, all before any AI call', async () => {
    reset(); const { token } = await paid(); ai.calls = 0;
    assert.equal((await callTailor(token, { jobDescription: '' })).statusCode, 400);
    assert.equal((await callTailor(token, { jobDescription: 'x'.repeat(10001) })).statusCode, 413);
    assert.equal((await callTailor(token, { resumeData: 'nope' })).statusCode, 400);
    assert.equal((await callTailor(token, { resumeData: { name: 'x'.repeat(70000) } })).statusCode, 413);
    assert.equal((await hs.tailor({ httpMethod: 'GET' })).statusCode, 405);
    delete process.env.TAILOR_TOKEN_SECRET; assert.equal((await callTailor(token)).statusCode, 503);
    assert.equal(ai.calls, 0);
  });

  // ---------------- compatibility, retirement, preservation ----------------
  await t.test('consume-generation shim never writes: counts stay put; stale-tab sequence is rejected without charge', async () => {
    reset(); const c = await seed(3);
    for (let i = 0; i < 3; i++) { const b = parseBody(await hs.consume(post({ code: c }))); assert.equal(b.success, true); assert.equal(b.usesRemaining, 3); }
    assert.equal(await uses(c), 3);
    const stale = await hs.parse(post({ resumeText: RESUME_TEXT }));             // an old tab never sends a code
    assert.equal(stale.statusCode, 401); assert.equal(await uses(c), 3); assert.equal(ai.calls, 0);
    const ex = await seed(0); assert.equal(parseBody(await hs.consume(post({ code: ex }))).success, false);
    assert.equal(parseBody(await hs.consume(post({ code: 'FG-ZZZZ-9999' }))).success, false);
    assert.equal(parseBody(await hs.consume(post({ code: 'bad' }))).success, false);
  });

  await t.test('verify-license behaves exactly as before', async () => {
    const c = await seed(2), ex = await seed(0);
    assert.deepEqual(parseBody(await hs.verify(post({ code: c }))), { valid: true, usesRemaining: 2, maxUses: 5 });
    assert.equal(parseBody(await hs.verify(post({ code: ex }))).valid, false);
    assert.equal(parseBody(await hs.verify(post({ code: 'FG-ZZZZ-9999' }))).error, 'We couldn’t find that code.');
    assert.equal((await hs.verify(post('{bad'))).statusCode, 400);
  });

  await t.test('Zapier-era endpoint is gone and no function can reach the anon role or the Zapier assignment path', () => {
    assert.ok(!fs.existsSync(path.join(FUNCS, 'assign-next-code.js')));
    const files = fs.readdirSync(FUNCS, { recursive: true }).filter(f => f.endsWith('.js'));
    for (const f of files) {
      const src = fs.readFileSync(path.join(FUNCS, f), 'utf8');
      assert.ok(!/assign_next_license|assign-next-code/i.test(src), `${f} still references the retired assignment path`);
      assert.ok(!/ANON|anon_key|SUPABASE_ANON/i.test(src), `${f} references an anon key`);
      assert.ok(!/zapier/i.test(src), `${f} still mentions Zapier`);
    }
    const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'schema.sql'), 'utf8');
    assert.ok(!/create (or replace )?function assign_next_license/i.test(schema));
  });

  await db.close();
});
