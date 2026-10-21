// "Polish My Resume with AI": exactly ONE of the included generations per successful polish, charged by the same
// reserve -> AI -> validate -> commit / release model as Analyze. Real handlers against real SQL; AI mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, loadHandlers, post, sleep, parseBody, installAi, captureLogs } = require('./harness');

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
let seq = 0;
const newCode = () => `FG-P${String(++seq).padStart(3, '0')}-BBBB`;

// A first-time applicant: no work history, fictional.
const ANSWERS = {
  name: 'Taylor Rivera', contact: { phone: '', email: 'taylor.rivera@example.com', location: 'Dayton, OH', linkedin: '', website: '' },
  summary: { tagline: 'Seeking a customer service position', bullets: [], skills: ['Teamwork', 'Customer service'] },
  experience: [], education: [{ degree: 'High School Diploma', school: 'Oakwood High School', location: '', date: '2026', honors: '' }],
  certifications: [{ name: 'Food Handler Course', org: '', date: '2026' }],
  projects: [{ name: 'School food drive', description: 'Collected canned food for a local pantry', bullets: ['asked classmates to donate cans', 'sorted and counted the cans'] }],
  volunteer: [{ title: 'Volunteer', organization: 'Community Food Pantry', location: '', start: '2025', end: 'Present', bullets: ['packed grocery boxes on saturdays'] }], awards: []
};
const WORKER = {
  name: 'Michael Johnson', contact: { email: 'mj@example.com' }, summary: { tagline: 'Warehouse associate', bullets: [], skills: ['Forklift safety'] },
  experience: [{ title: 'Warehouse Associate', company: 'Fictional Freight Co', location: 'Dayton, OH', start: '2016', end: 'Present', summary: '', bullets: ['loaded trucks', 'checked orders'] }],
  education: [], certifications: [], projects: [], volunteer: [], awards: []
};
const clone = (o) => JSON.parse(JSON.stringify(o));

test('polish-resume against real SQL (AI provider mocked)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_polish');
  await db.admin(H.SUPABASE_DEFAULT_PRIVS);
  await H.liveState(db); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2);
  const hs = loadHandlers(db.pool('service_role', 40));
  const ai = installAi({});
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'mock', TAILOR_TOKEN_SECRET: SECRET, AI_TIMEOUT_MS: '1000' });

  const seed = async (uses = 5) => { const c = newCode(); await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const uses = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const rsv = async (c) => (await db.admin('select status, tailor_count from license_reservations where code=$1 order by created_at', [c])).rows;
  const polish = (code, resume = ANSWERS, extra = {}) => hs.polish(post({ code, resume, target: 'customer service', ...extra }));
  const parse = (code) => hs.parse(post({ code, resumeText: 'Jordan Ellis — Retail Associate' }));
  const reset = () => { ai.mode = 'ok'; ai.delayMs = 0; ai.calls = 0; ai.maxInflight = 0; ai.polishPayload = null; hs.polishModule._recent.clear(); process.env.TAILOR_TOKEN_SECRET = SECRET; process.env.AI_TIMEOUT_MS = '1000'; };

  await t.test('rejected before any AI call and before any reservation: no code, bad format, unknown, exhausted, nothing to polish, malformed, oversized', async () => {
    reset(); const ex = await seed(0); const ok = await seed();
    const cases = [
      [{ resume: ANSWERS }, 401], [{ code: '', resume: ANSWERS }, 401], [{ code: 99, resume: ANSWERS }, 401], [{ code: 'nope', resume: ANSWERS }, 400],
      [{ code: 'FG-ZZZZ-9999', resume: ANSWERS }, 403], [{ code: ex, resume: ANSWERS }, 403],
      [{ code: ok }, 400], [{ code: ok, resume: [] }, 400], [{ code: ok, resume: 'text' }, 400],
      [{ code: ok, resume: { name: 'Only A Name', contact: { email: 'a@example.com' } } }, 400],            // nothing to reword: not charged
      [{ code: ok, resume: { ...ANSWERS, summary: { tagline: 'x'.repeat(70000), bullets: [], skills: [] } } }, 413],
    ];
    for (const [body, status] of cases) { const r = await hs.polish(post(body)); assert.equal(r.statusCode, status, JSON.stringify(body).slice(0, 80)); }
    assert.equal((await hs.polish(post('not json'))).statusCode, 400);
    assert.equal((await hs.polish({ httpMethod: 'GET' })).statusCode, 405);
    assert.equal(ai.calls, 0); assert.equal((await rsv(ok)).length, 0); assert.equal(await uses(ok), 5); assert.equal(await uses(ex), 0);
  });

  await t.test('success charges exactly ONE generation, returns counts and a tailoring token, never two', async () => {
    reset(); const c = await seed();
    const r = await polish(c); const b = parseBody(r);
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(b.result).name, 'Taylor Rivera');
    assert.equal(b.usesRemaining, 4); assert.equal(b.maxUses, 5); assert.ok(b.tailorToken); assert.ok(Array.isArray(b.unverified));
    assert.equal(await uses(c), 4); assert.deepEqual((await rsv(c)).map((x) => x.status), ['committed']); assert.equal(ai.calls, 1);
    assert.equal(JSON.stringify(b).includes(c), false);                                                       // the code is never echoed
  });

  await t.test('the token it issues works with Tailor exactly like an Analyze token: free, capped at 5 runs, expires', async () => {
    reset(); const c = await seed(); const tok = parseBody(await polish(c)).tailorToken;
    const rid = hs.tokens.verify(SECRET, tok).reservationId;
    const tailor = (token) => hs.tailor(post({ resumeData: ANSWERS, jobDescription: 'Cashier: friendly service', tailorToken: token }));
    for (let i = 0; i < 5; i++) assert.equal((await tailor(tok)).statusCode, 200, `run ${i + 1}`);
    assert.equal((await tailor(tok)).statusCode, 429);                                                        // limit per paid generation
    assert.equal(await uses(c), 4);                                                                           // Tailor never touched the balance
    assert.equal((await db.admin('select tailor_count c from license_reservations where id=$1', [rid])).rows[0].c, 5);
    const past = Date.now() - 3 * 3600 * 1000;
    assert.equal((await tailor(hs.tokens.sign(SECRET, rid, 3600, past))).statusCode, 401);                    // expired
    const other = hs.tokens.sign('different-secret-different-secret-012345678', rid, 3600);
    assert.equal((await tailor(other)).statusCode, 401);                                                      // tampered / wrong key
  });

  await t.test('a missing or short token secret never blocks the paid polish (tailoring is simply disabled)', async () => {
    reset(); const c = await seed(); delete process.env.TAILOR_TOKEN_SECRET;
    const r = await polish(c); assert.equal(r.statusCode, 200); assert.equal(parseBody(r).tailorToken, null); assert.equal(await uses(c), 4);
    process.env.TAILOR_TOKEN_SECRET = 'short'; assert.equal(parseBody(await polish(c)).tailorToken, null);
  });

  await t.test('EVERY failure mode is free: provider errors, timeout, truncated, empty, not JSON, wrong shape, network', async () => {
    for (const mode of ['http500', 'hang', 'truncated', 'empty', 'notjson', 'badshape', 'throw']) {
      reset(); const c = await seed(); ai.mode = mode;
      const r = await polish(c);
      assert.equal(r.statusCode, 502, mode); assert.match(parseBody(r).error, /haven’t been charged/, mode);
      assert.equal(await uses(c), 5, mode);
      assert.ok((await rsv(c)).every((x) => x.status !== 'committed'), mode);
      ai.mode = 'ok'; assert.equal((await polish(c)).statusCode, 200, `${mode}: the customer can simply try again`);
      assert.equal(await uses(c), 4, mode);
    }
  });

  await t.test('throttling is preserved: 100 failing polishes => only 6 reach the AI, then 429 with Retry-After; nothing charged; others unaffected', async () => {
    reset(); const c = await seed(), other = await seed(); ai.mode = 'notjson';
    const out = []; for (let i = 0; i < 100; i++) out.push(await polish(c));
    assert.equal(ai.calls, 6);
    assert.ok(out.slice(6).every((r) => r.statusCode === 429));
    assert.equal(out[6].headers['Retry-After'], String(parseBody(out[6]).retryAfterSeconds));
    assert.equal(await uses(c), 5);
    ai.mode = 'ok'; assert.equal((await polish(other)).statusCode, 200);
    assert.equal((await polish(c)).statusCode, 429);
  });

  await t.test('provider outages never throttle: 40 failures in a row, then an instant success', async () => {
    reset(); const c = await seed();
    ai.mode = 'http500'; for (let i = 0; i < 20; i++) assert.equal((await polish(c)).statusCode, 502);
    ai.mode = 'throw'; for (let i = 0; i < 20; i++) assert.equal((await polish(c)).statusCode, 502);
    ai.mode = 'ok'; assert.equal((await polish(c)).statusCode, 200); assert.equal(await uses(c), 4);
  });

  await t.test('double-click / simultaneous requests: never overlapping, never over-charged, charged == successes', async () => {
    reset(); const c = await seed(); ai.delayMs = 120;
    const rs = await Promise.all(Array.from({ length: 20 }, () => polish(c)));
    const ok = rs.filter((r) => r.statusCode === 200).length; const busy = rs.filter((r) => r.statusCode === 409);
    assert.ok(ok >= 1); assert.ok(busy.length >= 1, 'duplicates are rejected');
    assert.ok(busy.every((r) => /already in progress/.test(parseBody(r).error)));
    assert.equal(ai.maxInflight, 1, 'only one paid operation runs at a time for a code');
    assert.equal(5 - (await uses(c)), ok);                                                                    // every charge matches a delivered result
    assert.ok((await uses(c)) >= 0);
    assert.equal((await rsv(c)).filter((x) => x.status === 'committed').length, ok);
  });

  await t.test('two near-simultaneous polishes on a code with ONE generation left: exactly one result, exactly one charge', async () => {
    reset(); const c = await seed(1); ai.delayMs = 80;
    const rs = await Promise.all([polish(c), polish(c), polish(c)]);
    assert.equal(rs.filter((r) => r.statusCode === 200).length, 1);
    assert.equal(await uses(c), 0);
    assert.equal((await polish(c)).statusCode, 403);                                                          // exhausted: no AI call
    assert.equal(ai.calls, 1);
  });

  await t.test('retry with the same requestId after a finished polish returns the same result and is NOT charged again; a new id is a new charge', async () => {
    reset(); const c = await seed();
    const a = await polish(c, ANSWERS, { requestId: 'req-aaaa-1111' }); const b = await polish(c, ANSWERS, { requestId: 'req-aaaa-1111' });
    assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200); assert.equal(a.body, b.body);
    assert.equal(await uses(c), 4); assert.equal(ai.calls, 1);
    assert.equal((await polish(c, ANSWERS, { requestId: 'req-bbbb-2222' })).statusCode, 200);
    assert.equal(await uses(c), 3); assert.equal(ai.calls, 2);
    assert.equal((await polish(c, ANSWERS, { requestId: '../bad id' })).statusCode, 200);                      // malformed ids are ignored, not trusted
    assert.equal(await uses(c), 2);
  });

  await t.test('a polish is rejected, uncharged, while an Analyze on the same code is still running (and vice versa)', async () => {
    reset(); const c = await seed(); ai.delayMs = 150;
    const first = parse(c); await sleep(40);
    const second = await polish(c);
    assert.equal(second.statusCode, 409);
    assert.equal((await first).statusCode, 200); assert.equal(await uses(c), 4);                              // only the Analyze was charged
  });

  await t.test('Analyze still costs exactly 1 and Tailor 0 alongside polish: polish + analyze = 2 used', async () => {
    reset(); const c = await seed();
    assert.equal((await parse(c)).statusCode, 200); assert.equal(await uses(c), 4);
    assert.equal((await polish(c)).statusCode, 200); assert.equal(await uses(c), 3);
    const tok = parseBody(await parse(c)).tailorToken; assert.equal(await uses(c), 2);
    assert.equal((await hs.tailor(post({ resumeData: ANSWERS, jobDescription: 'job', tailorToken: tok }))).statusCode, 200);
    assert.equal(await uses(c), 2);
  });

  await t.test('credit exhaustion: five polishes use the five included generations, the sixth is refused with no AI call', async () => {
    reset(); const c = await seed();
    for (let i = 0; i < 5; i++) assert.equal((await polish(c)).statusCode, 200, `polish ${i + 1}`);
    assert.equal(await uses(c), 0); const calls = ai.calls;
    const r = await polish(c); assert.equal(r.statusCode, 403); assert.equal(parseBody(r).usesRemaining, 0);
    assert.equal(ai.calls, calls);
  });

  await t.test('truthful content: invented jobs, changed facts and made-up metrics cannot get through unflagged', async () => {
    reset(); const c = await seed();
    ai.polishPayload = (src) => {
      const o = clone(src);
      o.name = 'Tay Rivers'; o.experience = [{ title: 'Store Manager', company: 'Big Retail Inc', start: '2020', end: '2024', bullets: ['Supervised 25 employees'] }];
      o.education[0].degree = 'MBA'; o.certifications.push({ name: 'CDL Class A', org: 'DMV', date: '2025' });
      o.summary = { tagline: 'Dynamic leader with a proven record of results', bullets: ['Increased donations by 300%'], skills: ['Teamwork', 'Salesforce'] };
      o.projects[0].bullets = ['Organized a food drive that collected 1,200 cans', 'Sorted and counted the cans'];
      return o;
    };
    const b = parseBody(await polish(c)); const out = JSON.parse(b.result);
    assert.equal(out.name, 'Taylor Rivera');                                                                  // facts restored
    assert.deepEqual(out.experience, []);                                                                     // no work history is NOT an error, and none is invented
    assert.equal(out.education[0].degree, 'High School Diploma');
    assert.deepEqual(out.certifications, ANSWERS.certifications);
    const flagged = b.unverified.map((u) => u.text);
    for (const must of ['Dynamic leader with a proven record of results', 'Increased donations by 300%', 'Organized a food drive that collected 1,200 cans', 'Salesforce'])
      assert.ok(flagged.includes(must), `should flag: ${must}`);
    assert.equal(flagged.includes('Sorted and counted the cans'), false);                                      // an honest rewording is not flagged
    assert.equal(await uses(c), 4);                                                                           // flagging never changes the charge
  });

  await t.test('an AI-written summary on an empty summary is always flagged for confirmation, even with no suspicious words', async () => {
    reset(); const c = await seed();
    const base = clone(ANSWERS); base.summary = { tagline: '', bullets: [], skills: ['Teamwork'] };
    ai.polishPayload = (src) => { const o = clone(src); o.summary.tagline = 'Friendly and reliable newcomer'; return o; };
    const b = parseBody(await polish(c, base));
    assert.deepEqual(b.unverified.map((u) => u.text), ['Friendly and reliable newcomer']);
    assert.match(b.unverified[0].reasons[0], /confirm this describes you/);
  });

  await t.test('long-tenure worker: facts, dates and the single long job are preserved; reworded bullets are accepted', async () => {
    reset(); const c = await seed();
    ai.polishPayload = (src) => { const o = clone(src); o.experience[0].bullets = ['Loaded and unloaded freight trucks', 'Checked orders for accuracy']; return o; };
    const out = JSON.parse(parseBody(await polish(c, WORKER)).result);
    assert.deepEqual([out.experience[0].title, out.experience[0].company, out.experience[0].start, out.experience[0].end], ['Warehouse Associate', 'Fictional Freight Co', '2016', 'Present']);
    assert.deepEqual(out.experience[0].bullets, ['Loaded and unloaded freight trucks', 'Checked orders for accuracy']);
  });

  await t.test('logs never contain the license code or the customer’s text, on success or failure', async () => {
    reset(); const logs = captureLogs();
    try {
      const c = await seed(); ai.mode = 'notjson'; await polish(c); ai.mode = 'truncated'; await polish(c);
      delete process.env.TAILOR_TOKEN_SECRET; ai.mode = 'ok'; await polish(c);
      const all = logs.lines.join('\n');
      assert.ok(!all.includes(c)); assert.ok(!all.includes('Taylor Rivera')); assert.ok(!all.includes('food drive'));
    } finally { logs.restore(); process.env.TAILOR_TOKEN_SECRET = SECRET; }
  });

  await t.test('the AI is never called for browsing: verify-license and consume-generation stay read-only', async () => {
    reset(); const c = await seed(); const before = ai.calls;
    assert.equal((await hs.verify(post({ code: c }))).statusCode, 200);
    assert.equal((await hs.consume(post({ code: c }))).statusCode, 200);
    assert.equal(ai.calls, before); assert.equal(await uses(c), 5); assert.equal((await rsv(c)).length, 0);
  });

  await db.drop?.();
});
