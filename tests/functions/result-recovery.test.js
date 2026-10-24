// Temporary encrypted recovery of a COMPLETED, CHARGED Analyze / AI Polish result (migration 04), through the real handlers and real SQL (AI mocked).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { H, loadHandlers, post, parseBody, installAi, captureLogs } = require('./harness');

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
let seq = 0;
const newCode = () => `FG-V${String(++seq).padStart(3, '0')}-VVVV`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const TEXT = 'Jordan Ellis. Retail Associate at Fictional Maple Market, June 2023 to August 2026. Assisted customers at the register and stocked shelves.';
const BASE = ['Rang up purchases for custmers', 'Counted the cash drawer at clossing', 'Stocked shelves with new merchandize', 'Answered questons about prices'];
const FIXED = ['Rang up purchases for customers', 'Counted the cash drawer at closing', 'Stocked shelves with new merchandise', 'Answered questions about prices'];
const RESUME = { name: 'Lena Ortiz', contact: { email: 'lena.ortiz@example.com' }, summary: { tagline: 'Retail clerk', bullets: [], skills: ['Cash handling'] },
  experience: [{ title: 'Retail Clerk', company: 'Fictional Dollar Shop', location: '', start: '2020', end: '2024', summary: '', bullets: BASE }],
  education: [], certifications: [], projects: [], volunteer: [], awards: [] };
const fixAll = (r) => { const o = clone(r); o.experience[0].bullets = FIXED.slice(); return o; };

test('vault: authenticated encryption of the recovery copy', async (t) => {
  const keep = { k: process.env.RESULT_ENCRYPTION_KEY, p: process.env.RESULT_ENCRYPTION_KEY_PREVIOUS };
  t.after(() => { process.env.RESULT_ENCRYPTION_KEY = keep.k; if (keep.p === undefined) delete process.env.RESULT_ENCRYPTION_KEY_PREVIOUS; else process.env.RESULT_ENCRYPTION_KEY_PREVIOUS = keep.p; });
  const vault = require('../../netlify/functions/_lib/vault');
  const A = 'A'.repeat(40); const B = 'B'.repeat(40);
  const plain = JSON.stringify({ result: '{"name":"Lena Ortiz","bullets":["Rang up purchases for customers"]}' });
  process.env.RESULT_ENCRYPTION_KEY = A; delete process.env.RESULT_ENCRYPTION_KEY_PREVIOUS;

  await t.test('round trip; the ciphertext holds none of the plaintext; every seal uses a fresh salt and IV', () => {
    const s1 = vault.seal(plain, { recordId: 'r1', fn: 'polish' }); const s2 = vault.seal(plain, { recordId: 'r1', fn: 'polish' });
    assert.equal(vault.open(s1, { recordId: 'r1', fn: 'polish' }), plain);
    for (const f of [s1.ct, s1.salt, s1.iv, s1.kid]) assert.equal(/Lena|Ortiz|purchases/.test(Buffer.from(f, 'base64').toString('latin1') + f), false);
    assert.notEqual(s1.salt, s2.salt); assert.notEqual(s1.iv, s2.iv); assert.notEqual(s1.ct, s2.ct);
  });
  await t.test('any change is detected: tampered ciphertext, another record id, another kind, a truncated record, a wrong key', () => {
    const s = vault.seal(plain, { recordId: 'r1', fn: 'polish' }); const raw = Buffer.from(s.ct, 'base64'); raw[3] ^= 1;
    assert.throws(() => vault.open({ ...s, ct: raw.toString('base64') }, { recordId: 'r1', fn: 'polish' }));
    assert.throws(() => vault.open(s, { recordId: 'r2', fn: 'polish' }), 'a row moved to another step');
    assert.throws(() => vault.open(s, { recordId: 'r1', fn: 'analyze' }), 'a row relabelled as another kind');
    assert.throws(() => vault.open({ ...s, ct: 'AAAA' }, { recordId: 'r1', fn: 'polish' }));
    process.env.RESULT_ENCRYPTION_KEY = B; assert.throws(() => vault.open(s, { recordId: 'r1', fn: 'polish' }), 'a different secret cannot open it');
    for (const e of [() => vault.open(s, { recordId: 'r1', fn: 'polish' })]) { try { e(); } catch (err) { assert.equal(/Lena|Ortiz/.test(String(err.message)), false, 'errors carry no content'); } }
    process.env.RESULT_ENCRYPTION_KEY = A;
  });
  await t.test('readiness: missing or short secrets mean "not ready" (paid steps refuse); rotation opens old records with the previous secret', () => {
    const s = vault.seal(plain, { recordId: 'r1', fn: 'polish' });
    process.env.RESULT_ENCRYPTION_KEY = 'short'; assert.equal(vault.ready(), false); assert.throws(() => vault.seal(plain, { recordId: 'r1', fn: 'polish' }));
    delete process.env.RESULT_ENCRYPTION_KEY; assert.equal(vault.ready(), false);
    process.env.RESULT_ENCRYPTION_KEY = B; process.env.RESULT_ENCRYPTION_KEY_PREVIOUS = A; assert.equal(vault.ready(), true);
    assert.equal(vault.open(s, { recordId: 'r1', fn: 'polish' }), plain, 'rotation overlap: the old record still opens');
    const fresh = vault.seal(plain, { recordId: 'r3', fn: 'polish' }); assert.notEqual(fresh.kid, s.kid, 'new records are sealed with the new secret');
    delete process.env.RESULT_ENCRYPTION_KEY_PREVIOUS; assert.throws(() => vault.open(s, { recordId: 'r1', fn: 'polish' }), 'after the overlap the old record cannot be opened');
    process.env.RESULT_ENCRYPTION_KEY = A;
  });
  await t.test('the secret is never the Tailor token secret and nothing is logged', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', '..', 'netlify', 'functions', '_lib', 'vault.js'), 'utf8');
    assert.equal(/TAILOR_TOKEN_SECRET/.test(src.replace(/\/\/.*$/gm, '')), false); assert.equal(/console\./.test(src), false);
  });
});

test('result recovery through the real handlers and real SQL (AI mocked)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_recov'); await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db);
  for (const m of [H.MIG1, H.MIG2, H.MIG3, H.MIG4]) await H.applyMigration(db, m);
  const ai = installAi({});
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'mock', TAILOR_TOKEN_SECRET: SECRET, AI_TIMEOUT_MS: '1000' });
  const fault = { commit: false };
  const faulty = (pool) => { const q = pool.query.bind(pool); pool.query = async (sql, p) => { if (fault.commit && /commit_license_use_with_result/.test(sql)) throw Object.assign(new Error('injected'), { code: '08006' }); return q(sql, p); }; return pool; };
  const instance = async () => { const hs = loadHandlers(faulty(db.pool('service_role', 10))); await hs.verify(post({ code: 'FG-ZZZZ-ZZZZ' })).catch(() => {}); hs.recover = require(path.join(hs.FUNCS, 'recover-result')).handler; hs.purge = require(path.join(hs.FUNCS, 'purge-recovery')).handler; return hs; };
  const seed = async (uses = 5) => { const c = newCode(); await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const uses = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const reset = () => { ai.mode = 'ok'; ai.delayMs = 0; ai.calls = 0; ai.polishPayload = null; fault.commit = false; };
  const analyze = (hs, code, extra = {}) => hs.parse(post({ code, resumeText: TEXT, ...extra }));
  const polish = (hs, code, extra = {}) => hs.polish(post({ code, resume: RESUME, target: 'retail', ...extra }));
  const rec = (hs, body, headers = {}) => hs.recover(post(body, { headers }));
  const copies = async (c) => (await db.admin('select * from result_recovery where code=$1', [c])).rows;

  await t.test('CHARGE + COPY: a charged Analyze and a charged Polish each store exactly one encrypted copy, report saved:true with an expiry within 24 hours, and the stored bytes contain none of the resume', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixAll; const A = await instance();
    const a = parseBody(await analyze(A, c)); const p = parseBody(await polish(A, c));
    assert.equal(a.saved, true); assert.equal(p.saved, true); assert.equal(await uses(c), 3);
    const rows = await copies(c); assert.equal(rows.length, 2); assert.deepEqual(rows.map((r) => r.fn).sort(), ['analyze', 'polish']);
    for (const r of rows) { assert.ok(new Date(r.expires_at) - new Date(r.created_at) <= 24 * 3600 * 1000 + 1000); assert.equal(/Jordan|Ellis|Lena|Ortiz|Maple|purchases|customers/i.test(JSON.stringify(r)), false, 'ciphertext only'); }
    for (const b of [a, p]) assert.ok(new Date(b.savedUntil) > new Date());
  });

  await t.test('FREE results store nothing: a below-threshold polish and a no-change polish leave no copy and need none', async () => {
    reset(); const c = await seed(); const A = await instance(); ai.polishPayload = (r) => { const o = clone(r); o.experience[0].bullets[0] = FIXED[0]; return o; };
    const free = parseBody(await polish(A, c)); assert.equal(free.charged, false); ai.polishPayload = (r) => r; await polish(A, c, { requestId: 'rec-free-0002' });
    assert.equal((await copies(c)).length, 0); assert.equal(parseBody(await rec(A, { code: c, action: 'list' })).results.length, 0); assert.equal(await uses(c), 5);
  });

  await t.test('RESTORE (the main scenario): the reply is lost, the browser restarts with NOTHING stored, the customer enters only the access code -> the exact result, no charge, no AI call, no Tailor run used', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixAll; const A = await instance();
    const original = parseBody(await polish(A, c, { requestId: 'rec-main-0001' }));                  // "lost": the page never saw it
    const B = await instance(); ai.calls = 0;                                                         // a different server, a new browser with no request id, no resume
    const list = parseBody(await rec(B, { code: c, action: 'list' })); assert.equal(list.results.length, 1); assert.equal(list.results[0].kind, 'polish'); assert.equal(list.usesRemaining, 4);
    assert.deepEqual(Object.keys(list.results[0]).sort(), ['expiresAt', 'id', 'kind', 'savedAt'], 'listing reveals no content');
    const got = await rec(B, { code: c, action: 'fetch', id: list.results[0].id }); const g = parseBody(got);
    assert.equal(got.statusCode, 200); assert.equal(g.result, original.result, 'the EXACT result, byte for byte'); assert.deepEqual(g.withheld, original.withheld); assert.deepEqual(g.changes, original.changes); assert.equal(g.points, original.points);
    assert.equal(g.charged, true); assert.equal(g.recovered, 'exact'); assert.match(g.message, /exactly as it was/); assert.match(g.supportRef, /^R-[0-9A-F]{8}$/);
    assert.equal(ai.calls, 0, 'no AI call'); assert.equal(await uses(c), 4, 'no generation used'); assert.equal(g.usesRemaining, 4);
    const again = parseBody(await rec(B, { code: c, action: 'fetch', id: list.results[0].id })); assert.equal(again.result, original.result, 'reading does not consume the copy');
    // Tailor: the restored authorization is for the SAME paid generation and adds no runs
    const tailorUsed = async () => (await db.admin("select tailor_count n from license_reservations where code=$1 and status='committed'", [c])).rows[0].n;
    assert.equal(await tailorUsed(), 0, 'restoring used no Tailor run');
    const t1 = await B.tailor(post({ resumeData: JSON.parse(g.result), tailorToken: g.tailorToken, jobDescription: 'Retail clerk: cash handling and customer service.' }));
    assert.notEqual(t1.statusCode, 401); assert.equal(await tailorUsed() <= 1, true); assert.equal(await uses(c), 4);
  });

  await t.test('RESTORE (Analyze): the exact analyzed resume comes back with the same unverified flags', async () => {
    reset(); const c = await seed(); const A = await instance(); const original = parseBody(await analyze(A, c));
    const list = parseBody(await rec(await instance(), { code: c, action: 'list' })); const g = parseBody(await rec(await instance(), { code: c, action: 'fetch', id: list.results[0].id }));
    assert.equal(g.result, original.result); assert.deepEqual(g.unverified, original.unverified); assert.equal(g.kind, 'analyze'); assert.equal(g.usesRemaining, original.usesRemaining);
  });

  await t.test('SAME REQUEST ID retried on a cold instance returns the EXACT stored result (not new wording), with no AI call, no charge and no recovery turn used', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixAll; const A = await instance(); const original = parseBody(await polish(A, c, { requestId: 'rec-exact-0001' }));
    ai.polishPayload = (r) => { const o = fixAll(r); o.experience[0].bullets[0] = 'DIFFERENT WORDING'; return o; };           // if the AI were called again the wording would change
    ai.calls = 0; const B = await instance(); const r1 = parseBody(await polish(B, c, { requestId: 'rec-exact-0001' }));
    assert.equal(r1.result, original.result); assert.equal(r1.recovered, 'exact'); assert.equal(ai.calls, 0); assert.equal(await uses(c), 4);
    for (let i = 0; i < 5; i++) assert.equal(parseBody(await polish(await instance(), c, { requestId: 'rec-exact-0001' })).result, original.result);
    assert.equal(ai.calls, 0, 'even after many retries the recovery limit is never reached because no AI is involved');
    assert.equal((await db.admin("select redelivery_count n from license_reservations where code=$1 and status='committed'", [c])).rows[0].n, 0);
  });

  await t.test('AUTHORIZATION: another code, an unknown code, a malformed id, an unknown id and a bad code format all get the same generic answer and learn nothing', async () => {
    reset(); const owner = await seed(); const other = await seed(); const A = await instance(); await analyze(A, owner);
    const id = parseBody(await rec(A, { code: owner, action: 'list' })).results[0].id; const seen = [];
    const probes = [{ code: other, action: 'fetch', id }, { code: 'FG-NONE-NONE', action: 'fetch', id }, { code: owner, action: 'fetch', id: '00000000-0000-4000-8000-000000000000' }, { code: owner, action: 'fetch', id: 'not-a-uuid' }, { code: owner, action: 'fetch' }, { code: owner, action: 'fetch', id: `${id}' or '1'='1` }];
    for (const body of probes) { const r = await rec(A, body); seen.push(r.statusCode + '|' + parseBody(r).error); assert.equal(JSON.stringify(parseBody(r)).includes(id), false); assert.ok(!parseBody(r).result); }
    assert.equal(new Set(seen).size, 1, `identical answers: ${[...new Set(seen)].join(' / ')}`); assert.match(seen[0], /^404\|We couldn’t find a saved result/);
    assert.equal(parseBody(await rec(A, { code: other, action: 'list' })).results.length, 0); assert.equal(parseBody(await rec(A, { code: 'FG-NONE-NONE', action: 'list' })).results.length, 0);
    assert.equal((await rec(A, { code: 'bad', action: 'list' })).statusCode, 400); assert.equal((await rec(A, { code: owner, action: 'delete' })).statusCode, 400);
    assert.equal((await A.recover({ httpMethod: 'GET' })).statusCode, 405); assert.equal((await A.recover({ httpMethod: 'POST', body: '{bad' })).statusCode, 400);
    assert.equal((await A.recover({ httpMethod: 'POST', body: JSON.stringify({ code: owner, action: 'list', pad: 'x'.repeat(5000) }) })).statusCode, 413);
  });

  await t.test('HAMMERING IS LIMITED per client: even valid lookups stop after 30 in a minute (the database is not a free probe), another client is unaffected', async () => {
    reset(); const owner = await seed(); const A = await instance(); const hammer = { 'x-nf-client-connection-ip': '203.0.113.91' }; const other = { 'x-nf-client-connection-ip': '203.0.113.92' };
    for (let i = 0; i < 30; i++) assert.equal((await rec(A, { code: owner, action: 'list' }, hammer)).statusCode, 200);
    const blocked = await rec(A, { code: owner, action: 'list' }, hammer); assert.equal(blocked.statusCode, 429); assert.ok(blocked.headers['Retry-After']);
    assert.equal((await rec(A, { code: owner, action: 'list' }, other)).statusCode, 200);
  });

  await t.test('GUESSING IS LIMITED per client: after 30 misses the client is told to wait (no database lookups), the real customer on another connection is unaffected', async () => {
    reset(); const owner = await seed(); const A = await instance(); await analyze(A, owner); const bad = { 'x-nf-client-connection-ip': '203.0.113.77' }; const good = { 'x-nf-client-connection-ip': '203.0.113.78' };
    for (let i = 0; i < 30; i++) assert.equal((await rec(A, { code: owner, action: 'fetch', id: '11111111-1111-4111-8111-111111111111' }, bad)).statusCode, 404);
    const blocked = await rec(A, { code: owner, action: 'fetch', id: '11111111-1111-4111-8111-111111111111' }, bad); assert.equal(blocked.statusCode, 429); assert.ok(blocked.headers['Retry-After']);
    assert.equal((await rec(A, { code: owner, action: 'list' }, bad)).statusCode, 429, 'the blocked client cannot list either');
    assert.equal((await rec(A, { code: owner, action: 'list' }, good)).statusCode, 200);
  });

  await t.test('EXPIRY: an expired copy is never returned even though cleanup has not run; the same-id retry then follows the normal rules; the hourly purge removes the row', async () => {
    reset(); const c = await seed(); const A = await instance(); await analyze(A, c, { requestId: 'rec-exp-0001' });
    await db.admin("update result_recovery set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where code=$1", [c]);
    const id = (await copies(c))[0].reservation_id; assert.equal((await copies(c)).length, 1, 'still physically present');
    assert.equal((await rec(await instance(), { code: c, action: 'fetch', id })).statusCode, 404);
    const purge = await (await instance()).purge({}); assert.equal(purge.statusCode, 200); assert.deepEqual(parseBody(purge), { ok: true }); assert.equal((await copies(c)).length, 0);
  });

  await t.test('FAILURE BEFORE COMPLETION: an AI failure stores nothing and charges nothing; the customer is told so and keeps their draft (nothing was sent anywhere)', async () => {
    reset(); const c = await seed(); const A = await instance(); ai.mode = 'http500'; const r = await analyze(A, c);
    assert.equal(r.statusCode, 502); assert.match(parseBody(r).error, /haven’t been charged/); assert.equal((await copies(c)).length, 0); assert.equal(await uses(c), 5);
  });

  await t.test('FAULT: the charge-with-copy call fails -> nothing charged, nothing stored, the customer is told to try again, and the retry works', async () => {
    reset(); const c = await seed(); const A = await instance(); fault.commit = true; const r = await analyze(A, c, { requestId: 'rec-fault-0001' }); fault.commit = false;
    assert.equal(r.statusCode, 503); assert.equal(await uses(c), 5); assert.equal((await copies(c)).length, 0);
    assert.equal((await analyze(A, c, { requestId: 'rec-fault-0001' })).statusCode, 200); assert.equal(await uses(c), 4); assert.equal((await copies(c)).length, 1);
  });

  await t.test('REQUIRED SECRET: without RESULT_ENCRYPTION_KEY every paid step (and the restore endpoint) refuses BEFORE any AI call or reservation; nothing is charged', async () => {
    reset(); const c = await seed(); const A = await instance(); const keep = process.env.RESULT_ENCRYPTION_KEY; delete process.env.RESULT_ENCRYPTION_KEY;
    const cap = captureLogs(); let a, p, l; try { a = await analyze(A, c); p = await polish(A, c); l = await rec(A, { code: c, action: 'list' }); } finally { cap.restore(); process.env.RESULT_ENCRYPTION_KEY = keep; }
    assert.equal(a.statusCode, 503); assert.equal(p.statusCode, 503); assert.equal(l.statusCode, 503); assert.equal(ai.calls, 0); assert.equal(await uses(c), 5);
    assert.equal((await db.admin('select count(*)::int n from license_reservations where code=$1', [c])).rows[0].n, 0, 'not even a reservation');
    assert.match(cap.lines.join('\n'), /RESULT_ENCRYPTION_KEY/);
  });

  await t.test('TAMPERED or unreadable copy: the restore answers the generic "not found" (no content, no stack), logs a content-free reference, and the paid step can still be re-delivered by regeneration', async () => {
    reset(); const c = await seed(); const A = await instance(); const original = parseBody(await analyze(A, c, { requestId: 'rec-tamper-0001' }));
    const id = (await copies(c))[0].reservation_id; await db.admin("update result_recovery set ct = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' where code=$1", [c]);
    const cap = captureLogs(); let r, retry; try { r = await rec(await instance(), { code: c, action: 'fetch', id }); ai.calls = 0; retry = await analyze(await instance(), c, { requestId: 'rec-tamper-0001' }); } finally { cap.restore(); }
    assert.equal(r.statusCode, 404); assert.equal(/Jordan|vault|gcm|auth/i.test(r.body), false); assert.match(cap.lines.join('\n'), /R301/); assert.equal(/Jordan|Ellis/.test(cap.lines.join('\n')), false);
    assert.equal(retry.statusCode, 200); assert.equal(ai.calls, 1, 'with no readable copy the honest regeneration fallback applies'); assert.equal(parseBody(retry).recovered, 'regenerated'); assert.equal(await uses(c), 4);
    assert.ok(original.saved);
  });

  await t.test('PRIVACY: logs and responses of the whole flow never contain the resume text, the access code, the secret, a copy or an id', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixAll; const A = await instance(); const cap = captureLogs(); let outs = [];
    try {
      outs.push(await polish(A, c, { requestId: 'rec-priv-0001' })); const B = await instance(); const l = await rec(B, { code: c, action: 'list' }); outs.push(l);
      const id = parseBody(l).results[0].id; outs.push(await rec(B, { code: c, action: 'fetch', id })); outs.push(await rec(B, { code: c, action: 'fetch', id: '22222222-2222-4222-8222-222222222222' }));
      outs.push(await polish(await instance(), c, { requestId: 'rec-priv-0001' }));
    } finally { cap.restore(); }
    const logs = cap.lines.join('\n'); const ct = (await copies(c))[0].ct;
    for (const needle of [c, process.env.RESULT_ENCRYPTION_KEY, SECRET, 'Lena Ortiz', 'Rang up purchases', ct]) assert.equal(logs.includes(needle), false, `log contains ${String(needle).slice(0, 12)}`);
    assert.equal(outs.some((o) => o.body.includes(ct) || o.body.includes(c) || o.body.includes(process.env.RESULT_ENCRYPTION_KEY)), false, 'no response echoes a code, a key or the stored bytes');
  });

  await t.test('EDITS AFTER the original step are the page\'s to protect: the endpoint returns only what was completed then, with its time, so the page can ask before replacing newer work', async () => {
    reset(); const c = await seed(); const A = await instance(); await analyze(A, c);
    const l = parseBody(await rec(A, { code: c, action: 'list' })); assert.ok(l.results[0].savedAt && l.results[0].expiresAt && new Date(l.results[0].savedAt) <= new Date());
  });

  await db.close();
});
