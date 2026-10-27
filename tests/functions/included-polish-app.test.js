// Included AI Polish and the four-day completion access, through the REAL Netlify handlers against a REAL (local, disposable) PostgreSQL with migrations 01-05
// applied. Only the AI provider is mocked. Fictional customers only; no paid call, no production system.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { H, loadHandlers, post, sleep, parseBody, installAi } = require('./harness');

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
let seq = 0;
const newCode = () => `FG-N${String(++seq).padStart(3, '0')}-DDDD`;
let rid = 0; const newRid = () => `req-incl-${String(++rid).padStart(6, '0')}`;

const WORKER = {
  name: 'Maria Delgado', contact: { phone: '(614) 555-0136', email: 'maria.delgado@example.com', location: 'Columbus, OH', linkedin: '', website: '' },
  summary: { tagline: 'Warehouse associate', bullets: [], skills: ['Forklift safety'] },
  experience: [{ title: 'Warehouse Associate', company: 'Fictional Freight Co', location: 'Columbus, OH', start: '2019', end: 'Present', summary: '', bullets: ['loaded trucks', 'counted stock every week'] }],
  education: [{ degree: 'High School Diploma', school: 'Central High School', location: '', date: '2018', honors: '' }], certifications: [], projects: [], volunteer: [], awards: []
};

test('included polish and four-day access: application against real SQL with migration 05 (AI mocked)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_app05'); await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db);
  for (const m of [H.MIG1, H.MIG2, H.MIG3, H.MIG4, H.MIG5]) await H.applyMigration(db, m);
  const hs = loadHandlers(db.pool('service_role', 40));
  const rr = require(path.join(hs.FUNCS, 'recover-result.js'));
  const ai = installAi({});
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'mock', TAILOR_TOKEN_SECRET: SECRET, AI_TIMEOUT_MS: '1000' });

  const seed = async (uses = 5) => { const c = newCode(); await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const uses = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const rows = async (c) => (await db.admin('select id, status, kind, included_polish_by, included_from, tailor_count from license_reservations where code=$1 order by created_at, id', [c])).rows;
  const reset = () => { ai.mode = 'ok'; ai.delayMs = 0; ai.calls = 0; ai.polishPayload = null; hs.polishModule._recent.clear(); hs.polishModule._nochange._events.clear(); hs.exportResume._limiters.perCode.reset(); hs.exportResume._limiters.failedLookups.reset(); };
  const parse = (code) => hs.parse(post({ code, resumeText: 'Jordan Ellis, Retail Associate' }));
  const polish = (code, extra = {}) => hs.polish(post({ code, resume: WORKER, target: 'warehouse', requestId: newRid(), ...extra }));
  const verify = async (code) => parseBody(await hs.verify(post({ code })));
  const download = (code) => hs.exportResume.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '203.0.113.7' }, body: JSON.stringify({ code, format: 'pdf', template: 'operator', alt: false, resume: WORKER }) });
  const backdate = (code, hours) => db.admin(`update license_reservations set committed_at = now() - make_interval(hours => $2) where code=$1 and status='committed'`, [code, hours]);

  await t.test('one Analyze costs 1 generation and earns exactly one included Polish; the code check reports it', async () => {
    reset(); const c = await seed(); const a = parseBody(await parse(c));
    assert.equal(await uses(c), 4); assert.ok(a.tailorToken);
    const v = await verify(c); assert.equal(v.valid, true); assert.equal(v.includedAvailable, 1); assert.equal(v.accessState, 'active'); assert.equal(v.usesRemaining, 4);
    assert.equal((await rows(c))[0].kind, 'analyze');
  });

  await t.test('the included Polish takes NO generation, claims the credit once, and re-signs the PARENT Analyze (no new Tailor runs)', async () => {
    reset(); const c = await seed(); const a = parseBody(await parse(c)); const parent = hs.tokens.verify(SECRET, a.tailorToken).reservationId;
    const r = await polish(c, { expectIncluded: true }); const b = parseBody(r);
    assert.equal(r.statusCode, 200); assert.equal(b.included, true); assert.equal(b.charged, false); assert.equal(b.usesRemaining, 4); assert.equal(await uses(c), 4);
    assert.equal(hs.tokens.verify(SECRET, b.tailorToken).reservationId, parent, 'the token names the paid Analyze, not the Polish');
    const rs = await rows(c); const polishRow = rs.find((x) => x.kind === 'polish');
    assert.equal(rs.find((x) => x.id === parent).included_polish_by, polishRow.id); assert.equal(polishRow.tailor_count, 0);
    assert.equal((await verify(c)).includedAvailable, 0);
    const tailor = (token) => hs.tailor(post({ resumeData: WORKER, jobDescription: 'Warehouse associate: safe forklift use', tailorToken: token }));
    for (let i = 0; i < 5; i++) assert.equal((await tailor(b.tailorToken)).statusCode, 200, `run ${i + 1}`);
    assert.equal((await tailor(b.tailorToken)).statusCode, 429, 'five runs in total for this Analyze, however many Polishes');
    assert.equal((await db.admin('select tailor_count c from license_reservations where id=$1', [parent])).rows[0].c, 5);
    assert.equal(await uses(c), 4);
  });

  await t.test('the NEXT meaningful Polish uses one generation', async () => {
    reset(); const c = await seed(); await parse(c); await polish(c, { expectIncluded: true });
    const r = await polish(c, { expectIncluded: false }); const b = parseBody(r);
    assert.equal(r.statusCode, 200); assert.equal(b.charged, true); assert.equal(b.included, undefined); assert.equal(b.usesRemaining, 3); assert.equal(await uses(c), 3);
  });

  await t.test('a Guided Builder customer (no Analyze): the first meaningful Polish uses one generation, and so does each one after it', async () => {
    reset(); const c = await seed();
    assert.equal(parseBody(await polish(c)).usesRemaining, 4); assert.equal(parseBody(await polish(c)).usesRemaining, 3); assert.equal((await verify(c)).includedAvailable, 0);
  });

  await t.test('NEVER SILENTLY PAID: a page that expected an included Polish, when none exists, is refused before the AI runs and charges nothing', async () => {
    reset(); const c = await seed(); const calls = ai.calls;
    const r = await polish(c, { expectIncluded: true }); const b = parseBody(r);
    assert.equal(r.statusCode, 409); assert.equal(b.code, 'included_unavailable'); assert.equal(b.newRequest, true); assert.equal(ai.calls, calls, 'no AI call was made');
    assert.equal(await uses(c), 5); assert.deepEqual((await rows(c)).map((x) => x.status), ['released']);
    const ok = await polish(c, { expectIncluded: false }); assert.equal(ok.statusCode, 200); assert.equal(await uses(c), 4, 'a deliberate paid Polish still works');
  });

  await t.test('FAILED, UNCHANGED or INSIGNIFICANT results leave the included Polish and the balance untouched', async () => {
    reset(); const c = await seed(); await parse(c);
    ai.polishPayload = (resume) => resume;                                                              // the AI changes nothing
    const same = parseBody(await polish(c, { expectIncluded: true })); assert.equal(same.noChange, true); assert.equal(same.charged, false);
    ai.polishPayload = null; ai.mode = 'throw';
    assert.equal((await polish(c, { expectIncluded: true })).statusCode, 502);                          // the AI fails
    ai.mode = 'truncated'; assert.equal((await polish(c, { expectIncluded: true })).statusCode, 502);   // unusable answer
    ai.mode = 'ok'; assert.equal(await uses(c), 4); assert.equal((await verify(c)).includedAvailable, 1, 'still available after every one of them');
    const real = parseBody(await polish(c, { expectIncluded: true })); assert.equal(real.included, true); assert.equal(await uses(c), 4);
  });

  await t.test('ZERO GENERATIONS LEFT: the included Polish still works; afterwards the AI is closed, and sign-in/download follow the four-day rule', async () => {
    reset(); const c = await seed(1); await parse(c); assert.equal(await uses(c), 0);
    let v = await verify(c); assert.equal(v.valid, true); assert.equal(v.usesRemaining, 0); assert.equal(v.includedAvailable, 1); assert.equal(v.accessState, 'active');
    assert.equal((await download(c)).statusCode, 200);
    const r = await polish(c, { expectIncluded: true }); assert.equal(r.statusCode, 200); assert.equal(parseBody(r).included, true); assert.equal(await uses(c), 0);
    const calls = ai.calls; const again = await polish(c); assert.equal(again.statusCode, 403); assert.equal(ai.calls, calls, 'no AI call without an entitlement');
    assert.equal((await hs.parse(post({ code: c, resumeText: 'Another resume' }))).statusCode, 403);
    v = await verify(c); assert.equal(v.valid, true); assert.equal(v.accessState, 'completion'); assert.ok(Date.parse(v.accessUntil) > Date.now() + 95 * 3600 * 1000);
  });

  await t.test('FOUR-DAY ACCESS: downloads and sign-in work for 96 hours after the last benefit, then are refused; AI is never granted', async () => {
    reset(); const c = await seed(1); await parse(c); await polish(c, { expectIncluded: true });
    await backdate(c, 95); let v = await verify(c); assert.equal(v.valid, true); assert.equal(v.accessState, 'completion'); assert.equal((await download(c)).statusCode, 200);
    assert.equal((await hs.polish(post({ code: c, resume: WORKER }))).statusCode, 403, 'inside the period: still no AI');
    await backdate(c, 97); v = await verify(c); assert.equal(v.valid, false); assert.equal(v.accessState, 'ended'); assert.match(v.error, /four-day/);
    const d = await download(c); assert.equal(d.statusCode, 403); assert.match(parseBody(d).error, /four-day finishing period/); assert.equal(d.headers['X-Access-State'], 'ended');
    const active = await seed(3); assert.equal((await download(active)).statusCode, 200, 'a code with generations left is never affected');
    await db.admin('update licenses set uses_remaining = 2 where code=$1', [c]); assert.equal((await download(c)).statusCode, 200, 'a top-up restores normal access');
  });

  await t.test('REPEATS: the same request id after a lost reply returns the same result: no AI call, no second credit, no generation', async () => {
    reset(); const c = await seed(); await parse(c); const id = newRid();
    const first = parseBody(await polish(c, { requestId: id, expectIncluded: true })); assert.equal(first.included, true); const calls = ai.calls;
    hs.polishModule._recent.clear();                                                                    // another server instance: only the database remembers
    const retry = await polish(c, { requestId: id, expectIncluded: true }); const b = parseBody(retry);
    assert.equal(retry.statusCode, 200); assert.equal(b.included, true); assert.equal(b.recovered, 'exact'); assert.equal(b.result, first.result); assert.equal(ai.calls, calls);
    assert.equal(await uses(c), 4); assert.equal((await rows(c)).filter((x) => x.included_polish_by).length, 1);
    assert.equal((await verify(c)).includedAvailable, 0);
  });

  await t.test('SIMULTANEOUS requests: the included Polish is used once, and the loser is told uncharged', async () => {
    reset(); const c = await seed(); await parse(c); ai.delayMs = 60;
    const rs = await Promise.all([polish(c, { expectIncluded: true }), polish(c, { expectIncluded: true })]);
    assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409]); assert.equal(await uses(c), 4);
    assert.equal((await rows(c)).filter((x) => x.included_polish_by).length, 1);
    ai.delayMs = 0;
  });

  await t.test('RESULT RECOVERY: a stored included Polish is restored exactly, as included, signed for its parent, and costs nothing', async () => {
    reset(); const c = await seed(); const a = parseBody(await parse(c)); const parent = hs.tokens.verify(SECRET, a.tailorToken).reservationId;
    const b = parseBody(await polish(c, { expectIncluded: true })); const polishRow = (await rows(c)).find((x) => x.kind === 'polish');
    const list = parseBody(await rr.handler(post({ code: c, action: 'list' }))); assert.ok(list.results.some((x) => x.id === polishRow.id && x.kind === 'polish'));
    const got = parseBody(await rr.handler(post({ code: c, action: 'fetch', id: polishRow.id })));
    assert.equal(got.included, true); assert.equal(got.charged, false); assert.equal(got.result, b.result); assert.equal(got.recovered, 'exact');
    assert.equal(hs.tokens.verify(SECRET, got.tailorToken).reservationId, parent);
    assert.equal(await uses(c), 4); assert.equal((await verify(c)).includedAvailable, 0);
  });

  await t.test('GUARD VERSION: a page from before this release is told to refresh, and is not charged', async () => {
    reset(); const c = await seed(); await parse(c);
    const r = await polish(c, { clientGuard: 'entry-scope-withhold-6' }); assert.equal(r.statusCode, 409); assert.equal(parseBody(r).stale, true); assert.equal(await uses(c), 4);
    assert.equal((await polish(c, { clientGuard: require(path.join(hs.FUNCS, '..', '..', 'resume-core.js')).GUARD_VERSION, expectIncluded: true })).statusCode, 200);
  });

  await t.test('OLD AND NEW TOGETHER: this build against a database WITHOUT migration 05 keeps sign-in and downloads as they were and refuses paid steps safely (nothing charged)', async () => {
    const keep = process.env.WITH_MIG5; process.env.WITH_MIG5 = '0';                                    // build the database as it is BEFORE migration 05
    const old = await H.freshDatabase('rg_app04'); await old.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(old);
    for (const m of [H.MIG1, H.MIG2, H.MIG3, H.MIG4]) await H.applyMigration(old, m);
    process.env.WITH_MIG5 = keep;
    const h2 = loadHandlers(old.pool('service_role', 10)); const c = newCode(); await H.seed(old, [{ code: c, uses: 2, assigned: true }]); const zero = newCode(); await H.seed(old, [{ code: zero, uses: 0, assigned: true }]);
    const v = parseBody(await h2.verify(post({ code: c }))); assert.equal(v.valid, true); assert.equal(v.usesRemaining, 2); assert.equal(v.includedAvailable, undefined);
    assert.equal(parseBody(await h2.verify(post({ code: zero }))).valid, false, 'the earlier zero-balance behaviour is unchanged until the migration is applied');
    const dl = await h2.exportResume.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '203.0.113.8' }, body: JSON.stringify({ code: zero, format: 'pdf', template: 'operator', alt: false, resume: WORKER }) });
    assert.equal(dl.statusCode, 200, 'downloads stay open as before');
    const r = await h2.polish(post({ code: c, resume: WORKER, requestId: newRid() })); assert.equal(r.statusCode, 503);
    assert.equal((await old.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u, 2); assert.equal((await old.admin('select count(*)::int n from license_reservations')).rows[0].n, 0);
    await old.close();
  });

  await db.close();
});
