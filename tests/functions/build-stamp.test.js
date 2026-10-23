// How the owner (and the page) can tell which build is running, for free: no licence, no AI, no reservation, no charge.
// Covers the browser-visible address check, unchanged blocking of unauthorised requests, and a stale page being refused before any billing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, loadHandlers, post, parseBody, installAi } = require('./harness');
const Core = require('../../resume-core.js');

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const RESUME = { name: 'Taylor Rivera', contact: { email: 'taylor.rivera@example.com' }, summary: { tagline: 'Seeking a customer service position', bullets: [], skills: ['Teamwork'] },
  experience: [], education: [], certifications: [], projects: [{ name: 'School Food Drive', description: '', bullets: ['Asked classmates to donate canned food'] }], volunteer: [], awards: [] };

test('opening an AI function in a browser (GET) is a readable 405 that names the guard version, and serves nothing else', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_stamp');
  await db.admin(H.SUPABASE_DEFAULT_PRIVS);
  await H.liveState(db); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2);
  const hs = loadHandlers(db.pool('service_role', 10));
  const ai = installAi({});
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'mock', TAILOR_TOKEN_SECRET: SECRET, AI_TIMEOUT_MS: '1000' });
  await H.seed(db, [{ code: 'FG-STMP-AAAA', uses: 5, assigned: true }]);
  const rows = async () => ({ lic: (await db.admin("select uses_remaining u from licenses where code='FG-STMP-AAAA'")).rows[0].u, rsv: (await db.admin('select count(*)::int n from license_reservations')).rows[0].n });
  const before = await rows(); const callsBefore = ai.calls;

  for (const [name, fn] of [['polish', hs.polish], ['tailor', hs.tailor], ['parse', hs.parse]]) {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      const r = await fn({ httpMethod: method, headers: {}, queryStringParameters: { code: 'FG-STMP-AAAA' } });
      assert.equal(r.statusCode, 405, `${name} ${method}`);
      assert.match(r.headers['Content-Type'], /application\/json/); assert.equal(r.headers.Allow, 'POST');
      const b = JSON.parse(r.body);                                     // what the Console's r.json() reads
      assert.equal(b.error, 'Method Not Allowed'); assert.equal(b.guard.version, Core.GUARD_VERSION); assert.equal(b.guard.withholds, true);
      assert.deepEqual(Object.keys(b).sort(), ['error', 'guard'], 'nothing but the label');
      assert.doesNotMatch(r.body, /FG-STMP|taylor|secret|key/i);
    }
  }
  assert.deepEqual(await rows(), before, 'no reservation, no charge'); assert.equal(ai.calls, callsBefore, 'no AI call');

  // Unauthorised POSTs are blocked exactly as before.
  const p = (body) => hs.polish(post(body));
  assert.equal((await p({})).statusCode, 401);
  assert.equal((await p({ code: 'nope', resume: RESUME })).statusCode, 400);
  assert.equal((await p({ code: 'FG-ZZZZ-9999', resume: RESUME })).statusCode, 403);
  assert.equal((await hs.tailor(post({ resumeData: RESUME, jobDescription: 'Cashier' }))).statusCode, 401);
  assert.equal((await hs.parse(post({ resumeText: 'Taylor Rivera' }))).statusCode, 401);
  assert.deepEqual(await rows(), before); assert.equal(ai.calls, callsBefore);

  // A POST with no code still tells which guard is running (the old console check), as JSON a Response can read.
  const probe = await p({}); assert.equal(probe.headers['Content-Type'], 'application/json'); assert.equal(JSON.parse(probe.body).guard.version, Core.GUARD_VERSION);

  // A page from an older deploy is refused before anything is reserved or charged; the current page, and an absent field, are served normally.
  for (const [fn, body] of [[hs.polish, { code: 'FG-STMP-AAAA', resume: RESUME, target: 'customer service' }], [hs.tailor, { resumeData: RESUME, jobDescription: 'Cashier' }], [hs.parse, { code: 'FG-STMP-AAAA', resumeText: 'Taylor Rivera, Cashier' }]]) {
    for (const stale of ['entry-scope-withhold-2', 'old', '']) {
      const r = await fn(post({ ...body, clientGuard: stale }));
      assert.equal(r.statusCode, 409, `stale "${stale}"`); const b = parseBody(r);
      assert.equal(b.stale, true); assert.match(b.error, /out of date.*refresh.*haven.t been charged/i); assert.equal(b.guard.version, Core.GUARD_VERSION);
    }
  }
  assert.deepEqual(await rows(), before, 'a stale page reserves nothing'); assert.equal(ai.calls, callsBefore, 'and spends nothing');
  const ok = await hs.polish(post({ code: 'FG-STMP-AAAA', resume: RESUME, target: 'customer service', clientGuard: Core.GUARD_VERSION }));
  assert.notEqual(ok.statusCode, 409);
  await db.drop?.();
});
