// The approved collective-improvement charging rule through the REAL polish handler and REAL SQL (the AI provider is mocked).
// Accepted improvements worth 3 points or more: applied, exactly ONE generation charged. Fewer: the customer's wording is kept, the reservation is
// released, nothing is charged. Rejected (withheld) material earns nothing. Retries, duplicates and races never double-charge.
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, loadHandlers, post, sleep, parseBody, installAi, captureLogs } = require('./harness');

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
let seq = 0;
const newCode = () => `FG-C${String(++seq).padStart(3, '0')}-CCCC`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const BASE = ['Rang up purchases for custmers', 'Counted the cash drawer at clossing', 'Stocked shelves with new merchandize', 'Answered questons about prices', 'Cleaned the registar area', 'Greeted customers at the entrence'];
const FIXED = ['Rang up purchases for customers', 'Counted the cash drawer at closing', 'Stocked shelves with new merchandise', 'Answered questions about prices', 'Cleaned the register area', 'Greeted customers at the entrance'];
const RESUME = { name: 'Lena Ortiz', contact: { email: 'lena.ortiz@example.com', location: 'Dayton, OH' }, summary: { tagline: 'Retail clerk', bullets: [], skills: ['Cash handling'] },
  experience: [{ title: 'Retail Clerk', company: 'Fictional Dollar Shop', location: 'Dayton, OH', start: '2020', end: '2024', summary: '', bullets: BASE }],
  education: [{ degree: 'High School Diploma', school: 'Oakwood High', location: '', date: '2020', honors: '' }], certifications: [], projects: [], volunteer: [], awards: [] };
const withBullets = (fn) => (r) => { const o = clone(r); o.experience[0].bullets = fn(o.experience[0].bullets); return o; };
const fixFirst = (n) => withBullets((b) => b.map((x, i) => (i < n ? FIXED[i] : x)));

test('collective charging against real SQL (AI provider mocked)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_collective');
  await db.admin(H.SUPABASE_DEFAULT_PRIVS);
  await H.liveState(db); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2);
  const hs = loadHandlers(db.pool('service_role', 40));
  const ai = installAi({});
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'mock', TAILOR_TOKEN_SECRET: SECRET, AI_TIMEOUT_MS: '1000' });
  const seed = async (uses = 5) => { const c = newCode(); await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const uses = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const rsv = async (c) => (await db.admin('select status from license_reservations where code=$1 order by created_at', [c])).rows.map((x) => x.status);
  const reset = () => { ai.mode = 'ok'; ai.delayMs = 0; ai.calls = 0; ai.maxInflight = 0; ai.polishPayload = null; hs.polishModule._recent.clear(); hs.polishModule._nochange._events.clear(); };
  const polish = (code, extra = {}, resume = RESUME) => hs.polish(post({ code, resume, target: 'retail', ...extra }));
  const bullets = (b) => JSON.parse(b.result).experience[0].bullets;

  await t.test('0 points (capitals and full stops only): free, nothing applied, reservation released, one AI call', async () => {
    reset(); const c = await seed(); ai.polishPayload = withBullets((b) => b.map((x) => `${x[0].toLowerCase()}${x.slice(1)}.`));
    const r = await polish(c); const b = parseBody(r);
    assert.equal(r.statusCode, 200); assert.equal(b.noChange, true); assert.equal(b.charged, false); assert.equal(b.reason, 'unchanged'); assert.equal(b.points, 0); assert.equal(b.result, undefined);
    assert.equal(await uses(c), 5); assert.deepEqual(await rsv(c), ['released']); assert.equal(ai.calls, 1);
  });

  await t.test('1 point (one typo put right): free and NOT applied, the customer is told why, nothing is charged', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixFirst(1);
    const r = await polish(c); const b = parseBody(r);
    assert.equal(b.noChange, true); assert.equal(b.charged, false); assert.equal(b.reason, 'minor'); assert.equal(b.points, 1); assert.equal(b.threshold, 3);
    assert.equal(b.result, undefined, 'the improved text is not handed out for free');
    assert.match(b.message, /three or more mistakes/); assert.equal(await uses(c), 5); assert.deepEqual(await rsv(c), ['released']);
    assert.equal(b.usesRemaining, 5);
  });

  await t.test('2 points (two typos): still free and not applied', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixFirst(2);
    const b = parseBody(await polish(c));
    assert.equal(b.charged, false); assert.equal(b.points, 2); assert.equal(b.result, undefined); assert.equal(await uses(c), 5);
  });

  await t.test('3 points (three typos): the fixes are applied and exactly ONE generation is charged', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixFirst(3);
    const r = await polish(c); const b = parseBody(r);
    assert.equal(r.statusCode, 200); assert.equal(b.charged, true); assert.equal(b.points, 3); assert.ok(b.tailorToken);
    assert.deepEqual(bullets(b).slice(0, 3), FIXED.slice(0, 3)); assert.deepEqual(bullets(b).slice(3), BASE.slice(3), 'only what the AI fixed changes');
    assert.equal(b.usesRemaining, 4); assert.equal(await uses(c), 4); assert.deepEqual(await rsv(c), ['committed']);
  });

  await t.test('six typos fixed is still ONE generation, never six', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixFirst(6);
    const b = parseBody(await polish(c));
    assert.equal(b.charged, true); assert.equal(b.points, 6); assert.deepEqual(bullets(b), FIXED); assert.equal(await uses(c), 4);
  });

  await t.test('one real rewrite (3 points): charged once', async () => {
    reset(); const c = await seed();
    const src = clone(RESUME); src.experience[0].bullets = ['worked on the register and helped customers', 'Counted money'];
    ai.polishPayload = withBullets(() => ['Operated the register and helped customers', 'Counted money']);
    const b = parseBody(await polish(c, {}, src));
    assert.equal(b.charged, true); assert.equal(b.points, 3); assert.equal(await uses(c), 4);
  });

  await t.test('rejected material earns nothing: two honest fixes + one invented line = 2 points, free; the invention never appears', async () => {
    reset(); const c = await seed();
    ai.polishPayload = withBullets((b) => [FIXED[0], 'Supervised a team of 12 cashiers, increasing sales by 40%', b[2], b[3], FIXED[4], b[5]]);
    const b = parseBody(await polish(c));
    assert.equal(b.charged, false); assert.equal(b.points, 2); assert.ok(b.withheld.length >= 1); assert.equal(b.result, undefined);
    assert.equal(JSON.stringify(b).includes('Supervised a team'), false, 'the withheld line itself is never handed out (the reason may quote one word)'); assert.equal(await uses(c), 5);
  });

  await t.test('mixed: three honest fixes + an invented line = charged once for the honest part; the invention is withheld and the rest is kept', async () => {
    reset(); const c = await seed();
    ai.polishPayload = withBullets((b) => [FIXED[0], FIXED[1], b[2], b[3], FIXED[4], 'Increased sales by 40% as a team leader']);
    const b = parseBody(await polish(c));
    assert.equal(b.charged, true); assert.equal(b.points, 3); assert.ok(b.withheld.length >= 1);
    const out = bullets(b); assert.equal(out.join('|').includes('40%'), false); assert.equal(out[5], BASE[5]); assert.equal(out[0], FIXED[0]);
    assert.equal(await uses(c), 4);
  });

  await t.test('the same underlying fix is not counted twice: one misspelling put right on five lines is 1 point and free', async () => {
    reset(); const c = await seed();
    const src = clone(RESUME); src.experience[0].bullets = [0, 1, 2, 3, 4].map((i) => `Rang up item ${i} for custmers`);
    ai.polishPayload = withBullets((b) => b.map((x) => x.replace('custmers', 'customers')));
    const b = parseBody(await polish(c, {}, src));
    assert.equal(b.points, 1); assert.equal(b.charged, false); assert.equal(await uses(c), 5);
  });

  await t.test('retry with the same requestId after a charged polish: the same answer, NOT charged again, no second AI call; a new id is a new charge', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixFirst(3);
    const a = parseBody(await polish(c, { requestId: 'req-charge-0001' }));
    const again = parseBody(await polish(c, { requestId: 'req-charge-0001' }));
    assert.deepEqual(again, a); assert.equal(ai.calls, 1); assert.equal(await uses(c), 4);
    await polish(c, { requestId: 'req-charge-0002' }); assert.equal(ai.calls, 2); assert.equal(await uses(c), 3);
  });

  await t.test('retry with the same requestId after a FREE polish: the same free answer, no second AI call, no extra reservation', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixFirst(2);
    const a = parseBody(await polish(c, { requestId: 'req-free-00001' }));
    const again = parseBody(await polish(c, { requestId: 'req-free-00001' }));
    assert.deepEqual(again, a); assert.equal(ai.calls, 1); assert.equal((await rsv(c)).length, 1); assert.equal(await uses(c), 5);
  });

  await t.test('LAST CREDIT: six simultaneous polishes that would each earn a charge produce exactly one charge, never a negative balance', async () => {
    reset(); const c = await seed(1); ai.delayMs = 120; ai.polishPayload = fixFirst(3);
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => polish(c)));
    const ok = rs.filter((r) => r.statusCode === 200 && parseBody(r).charged === true);
    assert.equal(ok.length, 1, rs.map((r) => r.statusCode).join(','));
    assert.equal(await uses(c), 0); assert.equal(ai.maxInflight, 1, 'never two paid AI calls at once');
    const left = (await rsv(c)).filter((s) => s === 'reserved').length; assert.equal(left, 0, 'no reservation left holding the code');
  });

  await t.test('free results still count against the free-attempt cap: the 4th small-fix result in a row is refused BEFORE any AI call', async () => {
    reset(); const c = await seed(); ai.polishPayload = fixFirst(1);
    for (let i = 0; i < 3; i++) assert.equal(parseBody(await polish(c)).reason, 'minor');
    const calls = ai.calls; const r = await polish(c);
    assert.equal(r.statusCode, 429); assert.equal(ai.calls, calls, 'no AI call for a capped request'); assert.equal(await uses(c), 5);
  });

  await t.test('every failure is still free (provider error, refusal, truncation, malformed) and the outcome log carries counts, never text', async () => {
    reset(); const c = await seed();
    for (const mode of ['http500', 'refusal', 'truncated', 'notjson']) { ai.mode = mode; const r = await polish(c); assert.equal(r.statusCode, 502, mode); assert.equal(await uses(c), 5, mode); }
    ai.mode = 'ok'; ai.polishPayload = fixFirst(3);
    const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' ')); const cap = captureLogs();
    try { await polish(c); } finally { console.log = orig; cap.restore(); }
    const outcome = lines.find((l) => l.startsWith('ai-outcome ')); assert.ok(outcome, 'an outcome line is written');
    assert.match(outcome, /"points":3/); assert.equal(outcome.includes(c), false); assert.equal(/custmers|Ortiz|lena/i.test(lines.join('\n') + cap.lines.join('\n')), false);
  });

  await db.close();
});
