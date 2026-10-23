// Analyze (parse-resume) gets the same protections as AI Polish: one paid operation at a time per code, replay of a finished request without a
// second charge, and a limit on guessing codes. Also: timeout wording, and that database errors never put the code into a log.
// Real handlers against real SQL; the AI provider is mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, loadHandlers, post, sleep, parseBody, installAi, captureLogs } = require('./harness');

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
let seq = 0;
const newCode = () => `FG-A${String(++seq).padStart(3, '0')}-AAAA`;
const TEXT = 'Jordan Ellis. Retail Associate at Fictional Maple Market, June 2023 to August 2026. Assisted customers.';

test('Analyze: one at a time, replay-safe, guess-limited (real SQL, AI mocked)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_analyze_guard');
  await db.admin(H.SUPABASE_DEFAULT_PRIVS);
  await H.liveState(db); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2);
  const pool = db.pool('service_role', 40);
  const realQuery = pool.query.bind(pool); let breakReserveFor = null;
  pool.query = async (sql, params) => { if (breakReserveFor && /reserve_license_use/.test(sql)) throw Object.assign(new Error(`could not serialize access for code ${breakReserveFor}`), { code: '40001' }); return realQuery(sql, params); };
  const hs = loadHandlers(pool);
  const ai = installAi({});
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'mock', TAILOR_TOKEN_SECRET: SECRET, AI_TIMEOUT_MS: '1000' });
  const seed = async (uses = 5) => { const c = newCode(); await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const uses = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const rsv = async (c) => (await db.admin('select status from license_reservations where code=$1 order by created_at', [c])).rows.map((x) => x.status);
  const reset = () => { ai.mode = 'ok'; ai.delayMs = 0; ai.calls = 0; ai.maxInflight = 0; ai.polishPayload = null; hs.polishModule._recent.clear(); hs.polishModule._nochange._events.clear(); breakReserveFor = null; process.env.AI_TIMEOUT_MS = '1000'; };
  const parse = (code, extra = {}, headers = {}) => hs.parse(post({ code, resumeText: TEXT, ...extra }, { headers }));
  const polish = (code, extra = {}) => hs.polish(post({ code, resume: { name: 'Jordan Ellis', summary: { tagline: '', bullets: [], skills: [] }, experience: [{ title: 'Retail Associate', company: 'Fictional Maple Market', start: '2023', end: '2026', bullets: ['loaded trucks and checked orders every morning', 'helped customers find what they needed on the shelves'] }] }, target: 'retail', ...extra }));

  await t.test('REGRESSION: two simultaneous Analyze requests (double-send, second tab) run ONE AI call and charge ONE generation', async () => {
    reset(); const c = await seed(); ai.delayMs = 700;
    const rs = await Promise.all([parse(c), parse(c)]);
    assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(ai.calls, 1); assert.equal(ai.maxInflight, 1); assert.equal(await uses(c), 4);
    assert.equal((await rsv(c)).filter((s) => s === 'reserved').length, 0);
  });

  await t.test('five simultaneous Analyze requests on a five-generation code charge exactly one, not all five', async () => {
    reset(); const c = await seed(); ai.delayMs = 700;
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => parse(c)));
    assert.equal(rs.filter((r) => r.statusCode === 200).length, 1); assert.equal(ai.calls, 1); assert.equal(await uses(c), 4);
  });

  await t.test('Analyze and Polish never overlap on one code, in either order, and the loser is free', async () => {
    reset(); const c = await seed(); ai.delayMs = 700;
    const a = await Promise.all([parse(c), polish(c)]); assert.equal(a.filter((r) => r.statusCode === 200).length, 1); assert.equal(ai.calls, 1);
    reset(); const d = await seed(); ai.delayMs = 700;
    const b = await Promise.all([polish(d), parse(d)]); assert.equal(b.filter((r) => r.statusCode === 200).length, 1); assert.equal(ai.calls, 1);
    assert.equal(await uses(c) + await uses(d) >= 7, true, 'at most one charge each');
  });

  await t.test('sequential Analyze still works: five generations, then the sixth is refused with no AI call', async () => {
    reset(); const c = await seed();
    for (let i = 0; i < 5; i++) assert.equal((await parse(c)).statusCode, 200);
    const calls = ai.calls; const r = await parse(c); assert.equal(r.statusCode, 403); assert.equal(ai.calls, calls); assert.equal(await uses(c), 0);
  });

  await t.test('REPLAY: repeating a finished Analyze with the same requestId returns the same result and is NOT charged again; a new id is a new charge', async () => {
    reset(); const c = await seed();
    const a = parseBody(await parse(c, { requestId: 'analyze-req-0001' }));
    const again = parseBody(await parse(c, { requestId: 'analyze-req-0001' }));
    assert.deepEqual(again, a); assert.equal(ai.calls, 1); assert.equal(await uses(c), 4);
    assert.equal(JSON.stringify(a).includes(c), false, 'the code is never echoed');
    await parse(c, { requestId: 'analyze-req-0002' }); assert.equal(ai.calls, 2); assert.equal(await uses(c), 3);
  });

  await t.test('a malformed requestId is ignored (a normal request), and a failed attempt is never replayed', async () => {
    reset(); const c = await seed();
    await parse(c, { requestId: 'x' }); await parse(c, { requestId: 'x' }); assert.equal(await uses(c), 3, 'too short to be an id: two normal charges');
    reset(); const d = await seed(); ai.mode = 'http500';
    assert.equal((await parse(d, { requestId: 'analyze-req-0003' })).statusCode, 502);
    ai.mode = 'ok'; const ok = await parse(d, { requestId: 'analyze-req-0003' });
    assert.equal(ok.statusCode, 200); assert.equal(await uses(d), 4, 'the retry after a failure runs normally and is charged once');
  });

  await t.test('a replay needs the license to still exist: a deleted code gets nothing from the cache', async () => {
    reset(); const c = await seed(); await parse(c, { requestId: 'analyze-req-0004' });
    await db.admin('delete from licenses where code=$1', [c]);
    const r = await parse(c, { requestId: 'analyze-req-0004' }); assert.equal(r.statusCode, 403);
  });

  await t.test('GUESSING: after 30 unknown or malformed codes from one client, that client is slowed (429) on Analyze, Polish and the old shim; other clients are not', async () => {
    reset(); const real = await seed(); const ip = { 'x-nf-client-connection-ip': '203.0.113.9' }; const other = { 'x-nf-client-connection-ip': '203.0.113.10' };
    for (let i = 0; i < 30; i++) {
      const r = await parse(`FG-ZZ${String(i).padStart(2, '0')}-ZZZZ`, {}, ip); assert.equal(r.statusCode, 403);
    }
    assert.equal((await parse('FG-ZZZZ-ZZZZ', {}, ip)).statusCode, 429);
    const p = await hs.polish({ httpMethod: 'POST', headers: ip, body: JSON.stringify({ code: 'FG-ZZZZ-YYYY', resume: { name: 'x', summary: { tagline: 'a b c', bullets: [], skills: [] } } }) });
    assert.notEqual(p.statusCode, 429, 'polish has its own limiter; this client has not used it yet');
    const calls = ai.calls; assert.equal((await parse(real, {}, other)).statusCode, 200); assert.equal(ai.calls, calls + 1, 'another client is unaffected');
    const retry = (await parse('FG-ZZZZ-ZZZZ', {}, ip)); assert.ok(retry.headers['Retry-After'], 'the wait is stated');
  });

  await t.test('the old consume-generation shim cannot be used to probe codes without limit either', async () => {
    reset(); const ip = { 'x-nf-client-connection-ip': '203.0.113.20' };
    for (let i = 0; i < 30; i++) { const r = await hs.consume({ httpMethod: 'POST', headers: ip, body: JSON.stringify({ code: `FG-QQ${String(i).padStart(2, '0')}-QQQQ` }) }); assert.equal(r.statusCode, 200); }
    assert.equal((await hs.consume({ httpMethod: 'POST', headers: ip, body: JSON.stringify({ code: 'FG-QQQQ-QQQQ' }) })).statusCode, 429);
  });

  await t.test('Polish: guessing codes is limited per client too (30 unknown codes, then a stated wait), and a real customer on another connection is unaffected', async () => {
    reset(); const real = await seed(); const ip = { 'x-nf-client-connection-ip': '203.0.113.40' }; const other = { 'x-nf-client-connection-ip': '203.0.113.41' };
    const ask = (code, headers) => hs.polish({ httpMethod: 'POST', headers, body: JSON.stringify({ code, resume: { name: 'Test Person', contact: {}, experience: [{ title: 'Cashier', company: 'Fictional Grocery', start: '2019', end: '2024', bullets: ['stock shelves and help customers find items in the store'] }], education: [], summary: { bullets: [], skills: [] } } }) });
    const guess = (i) => `FG-${'PQRSTUVWXY'[Math.floor(i / 10)]}${'ABCDEFGHJK'[i % 10]}PP-PPPP`;
    for (let i = 0; i < 30; i++) assert.equal((await ask(guess(i), ip)).statusCode, 403);
    const blocked = await ask('FG-PPPP-PPPP', ip); assert.equal(blocked.statusCode, 429);
    assert.notEqual((await ask(real, other)).statusCode, 429);
  });

  await t.test('verify-license: guessing is limited per client (30 unknown or malformed codes), real customers on other connections are unaffected, and the wait is stated', async () => {
    reset(); const real = await seed(); const ip = { 'x-nf-client-connection-ip': '203.0.113.30' }; const other = { 'x-nf-client-connection-ip': '203.0.113.31' };
    const ask = (code, headers) => hs.verify({ httpMethod: 'POST', headers, body: JSON.stringify({ code }) });
    for (let i = 0; i < 30; i++) assert.equal(parseBody(await ask(`FG-VV${String(i).padStart(2, '0')}-VVVV`, ip)).valid, false);
    const blocked = await ask('FG-VVVV-VVVV', ip); assert.equal(blocked.statusCode, 429); assert.ok(blocked.headers['Retry-After']);
    assert.equal(parseBody(await ask(real, other)).valid, true);
  });

  await t.test('PRIVACY: a database error that echoes the license code is never written to a log (Analyze and Tailor)', async () => {
    reset(); const c = await seed(); breakReserveFor = c; const cap = captureLogs();
    try { const r = await parse(c); assert.equal(r.statusCode, 503); assert.equal(JSON.stringify(parseBody(r)).includes(c), false); } finally { cap.restore(); }
    assert.equal(cap.lines.join('\n').includes(c), false, cap.lines.join(' | '));
    breakReserveFor = null;
  });

  await t.test('WORDING: a slow AI is described as slow, not as a too-long resume; a truncated answer still says the resume is too long; both are free', async () => {
    reset(); const c = await seed(); ai.mode = 'hang'; process.env.AI_TIMEOUT_MS = '1000';
    const slow = parseBody(await parse(c)); assert.match(slow.error, /took too long to answer/); assert.equal(/too long (for the AI|to polish|to analyze)/.test(slow.error), false); assert.equal(await uses(c), 5);
    ai.mode = 'truncated'; const cut = parseBody(await parse(c)); assert.match(cut.error, /too long for the AI/); assert.equal(await uses(c), 5);
    ai.mode = 'hang'; const ps = parseBody(await polish(c)); assert.match(ps.error, /took too long to answer/); assert.equal(await uses(c), 5);
  });

  await db.close();
});
