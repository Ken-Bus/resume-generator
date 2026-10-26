// Beginner AI Polish (owner decision 2026-10-26), with fictional applicants and a MOCKED AI provider. No live AI, no real database, no real license.
//   1. honest entry-level wording for an applicant who explicitly chose the first-resume path and has no work history;
//   2. a skill the person HAS, a skill they WANT to learn and work they DID are never blurred;
//   3. a new line that only repeats skills or facts the resume already has is dropped and is not, by itself, worth a generation;
//   4. the approved 3-point threshold, the integrity guard, duplicate-charge protection and the recovery copy are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../resume-core.js');
const I = require('../../netlify/functions/_lib/integrity');
const S = require('../../netlify/functions/_lib/scoring');
const { H, loadHandlers, post, parseBody, installAi } = require('./harness');

const clone = (o) => JSON.parse(JSON.stringify(o));
const SECRET = 'test-secret-test-secret-test-secret-0123456789';

// ── fictional applicants ───────────────────────────────────────────────────────────────────────────────────────
const TAYLOR = { name: 'Taylor Morgan', contact: { email: 'taylor.morgan@example.com', location: 'Dayton, OH' },
  summary: { tagline: 'Seeking a Customer Service Associate position.', bullets: ['Good at communication and teamwork.'], skills: ['Communication', 'Teamwork', 'Organization', 'Customer service'] },
  experience: [], education: [{ degree: 'High School Diploma', school: 'Lincoln High School', location: '', date: '2026', honors: '' }], certifications: [], projects: [], volunteer: [], awards: [] };
const JORDAN = { name: 'Jordan Lee', contact: { email: 'jordan.lee@example.com' },
  summary: { tagline: 'looking for a job at a cafe', bullets: [], skills: ['teamwork', 'cash handling', 'organized'] }, experience: [],
  volunteer: [{ title: 'Volunteer', organization: 'Riverside Food Pantry', location: '', start: '2025', end: 'Present', bullets: ['i help sort cans and stuff on saturdays', 'helped hand out bags to people'] }],
  education: [{ degree: 'High School Diploma', school: 'Riverside High School', location: '', date: '2027', honors: '' }], certifications: [], projects: [], awards: [] };
const SAM = { name: 'Sam Rivera', contact: { email: 'sam.rivera@example.com' }, summary: { tagline: 'Interested in learning Excel for an office assistant job.', bullets: [], skills: ['Typing', 'Teamwork'] }, experience: [],
  education: [{ degree: 'High School Diploma', school: 'Oak High School', location: '', date: '2026', honors: '' }], certifications: [], projects: [], volunteer: [], awards: [] };
const MARIA = { name: 'Maria Alvarez', contact: { email: 'maria.alvarez@example.com' }, summary: { tagline: 'cashier with experiance', bullets: [], skills: ['customer service'] },
  experience: [{ title: 'Cashier', company: 'Fictional Fresh Market', location: '', start: '2023', end: '2025', summary: '', bullets: ['ran the register', 'help customers find stuff', 'handle returns'] }],
  education: [], certifications: [], projects: [], volunteer: [], awards: [] };

const edit = (fn) => (src) => { const o = clone(src); fn(o); return o; };
const ENTRY = 'Seeking an entry-level Customer Service Associate position.';

// ── unit level: no database ────────────────────────────────────────────────────────────────────────────────────────
const polishModule = (() => { try { return require('../../netlify/functions/polish-resume'); } catch (e) { return null; } })();

test('scoring: a new line made only of words the resume already has earns nothing; real new wording and splits score as approved', () => {
  const before = Core.clean(TAYLOR);
  const mk = (fn) => { const a = clone(before); fn(a); return S.score(before, a); };
  const restated = mk((a) => a.summary.bullets.push('Communication, teamwork, organization and customer service skills.'));
  assert.equal(restated.points, 0); assert.equal(restated.charge, false); assert.equal(restated.by.restated, 1); assert.equal(restated.by.added, 0);
  const again = mk((a) => { a.summary.bullets.push('Teamwork and organization.'); a.summary.bullets.push('Communication and customer service.'); });
  assert.equal(again.points, 0, 'two repeat lines are still worth nothing');
  const fresh = mk((a) => a.summary.bullets.push('Answered phones for the school office.'));           // genuinely new words (the guard decides separately whether they are supported)
  assert.equal(fresh.points, 3); assert.equal(fresh.by.added, 1);
  // a split of ONE existing line keeps its approved value (1 point per piece), it is not "restated"
  const runOn = Core.clean({ ...MARIA, experience: [{ ...MARIA.experience[0], bullets: ['Loaded trucks and counted stock every week'] }] });
  const split = clone(runOn); split.experience[0].bullets = ['Loaded trucks', 'Counted stock every week'];
  const sp = S.score(runOn, split); assert.equal(sp.by.restated, 0);
  // a rewrite that gives the SAME line new words still scores 3 (clarity improvements keep qualifying under the existing rules)
  const rewrite = mk((a) => { a.summary.tagline = 'Seeking an entry-level Customer Service Associate position, with communication, teamwork and organization skills.'; });
  assert.equal(rewrite.points, 3); assert.equal(rewrite.charge, true); assert.equal(rewrite.by.rewrite, 1);
  assert.equal(S.THRESHOLD, 3, 'the charging threshold is unchanged');
});

test('integrity: pruneRestatedAdditions drops only list lines that repeat the resume, in bullets and skills, and nothing else', () => {
  const before = Core.clean(TAYLOR);
  const after = clone(before);
  after.summary.bullets.push('Communication, teamwork, organization and customer service skills.');       // repeats the skills list
  after.summary.skills.push('Teamwork and communication');                                                 // repeats a skill
  after.summary.tagline = ENTRY;                                                                            // an edit, not an addition
  const r = I.pruneRestatedAdditions(before, after);
  assert.deepEqual(r.resume.summary.bullets, before.summary.bullets); assert.deepEqual(r.resume.summary.skills, before.summary.skills);
  assert.equal(r.resume.summary.tagline, ENTRY); assert.equal(r.pruned.length, 2);
  const keep = clone(before); keep.summary.bullets.push('Answered phones for the school office.');
  assert.deepEqual(I.pruneRestatedAdditions(before, keep).resume.summary.bullets, keep.summary.bullets, 'a line with new content is left to the guard, not pruned');
  const same = I.pruneRestatedAdditions(before, clone(before)); assert.equal(same.pruned.length, 0); assert.deepEqual(same.resume, before);
  // entry bullets: a genuine SPLIT of one line (the original is replaced by its pieces) is kept; a piece that only copies a line left as written is dropped
  const job = Core.clean({ ...MARIA, experience: [{ ...MARIA.experience[0], bullets: ['Loaded trucks and counted stock every week'] }] });
  const jobSplit = clone(job); jobSplit.experience[0].bullets = ['Loaded trucks', 'Counted stock every week'];
  assert.deepEqual(I.pruneRestatedAdditions(job, jobSplit).resume.experience[0].bullets, ['Loaded trucks', 'Counted stock every week']);
  const jobCopy = clone(job); jobCopy.experience[0].bullets = ['Loaded trucks and counted stock every week', 'Loaded trucks'];
  assert.deepEqual(I.pruneRestatedAdditions(job, jobCopy).resume.experience[0].bullets, ['Loaded trucks and counted stock every week']);
});

test('integrity: a level of experience the customer did not state is put back; with the explicit first-resume choice it is allowed', () => {
  const src = Core.clean(TAYLOR); const out = clone(src); out.summary.tagline = ENTRY;
  const strict = I.guardResume(src, out, { mode: 'polish', vocabulary: 'Customer Service Associate' });
  assert.equal(strict.resume.summary.tagline, src.summary.tagline); assert.match(strict.withheld[0].reasons.join(), /level of experience you did not state/); assert.equal(strict.withheld[0].label, 'Headline');
  const allowed = I.guardResume(src, out, { mode: 'polish', vocabulary: 'Customer Service Associate', entryLevel: true });
  assert.equal(allowed.resume.summary.tagline, ENTRY); assert.deepEqual(allowed.withheld, []);
  // words the customer wrote themselves are theirs
  const own = Core.clean({ ...TAYLOR, summary: { ...TAYLOR.summary, tagline: 'Beginner looking for a customer service job' } }); const o2 = clone(own); o2.summary.tagline = 'Beginner seeking a customer service job';
  assert.deepEqual(I.guardResume(own, o2, { mode: 'polish', vocabulary: 'customer service' }).withheld, []);
  // even with the explicit choice, other descriptions of the person are still refused by the existing checks
  for (const bad of ['Eager high school graduate seeking an entry-level Customer Service Associate position.', 'Seeking an entry-level Customer Service Associate position with opportunities to develop professional skills.']) {
    const x = clone(src); x.summary.tagline = bad; const g = I.guardResume(src, x, { mode: 'polish', vocabulary: 'Customer Service Associate', entryLevel: true });
    assert.equal(g.resume.summary.tagline, src.summary.tagline, bad); assert.ok(g.withheld.length >= 1, bad);
  }
});

test('prompt: entry-level wording is offered only to an explicit first-resume applicant with no work history; the skill / interest / experience rule is for everyone', () => {
  assert.ok(polishModule, 'polish-resume loads');
  const T = Core.clean(TAYLOR); const M = Core.clean(MARIA);
  const first = polishModule._buildPrompt(T, 'Customer Service Associate', 'first', true);
  const firstPlain = polishModule._buildPrompt(T, 'Customer Service Associate', 'first', false);
  const exp = polishModule._buildPrompt(M, 'cashier', 'experienced', false);
  assert.match(first, /ENTRY-LEVEL WORDING/); assert.match(first, /Seeking an entry-level Customer Service Associate position\./);
  for (const p of [firstPlain, exp]) { assert.doesNotMatch(p, /ENTRY-LEVEL WORDING/); assert.doesNotMatch(p, /Seeking an entry-level/); assert.match(p, /Do not describe the person as entry-level/); }
  for (const p of [first, firstPlain, exp]) {
    assert.match(p, /a skill the person says they HAVE stays a skill statement/); assert.match(p, /WANT TO LEARN or are interested in stays an interest/);
    assert.match(p, /Do not add a new line that only repeats skills or facts/); assert.match(p, /Never add a trait/);
    assert.match(p, /Interested in learning Excel/);                                                          // the stated / wanted / demonstrated example
    assert.match(p, /FACT RULES \(never break these\)/);                                                       // the fact rules are intact
  }
  assert.equal(polishModule._isEntryLevel('first', T), true);
  assert.equal(polishModule._isEntryLevel('first', M), false, 'work history listed: never entry-level');
  assert.equal(polishModule._isEntryLevel('', T), false, 'not chosen explicitly: not entry-level');
  assert.equal(polishModule._isEntryLevel('experienced', T), false);
  assert.equal(polishModule._isEntryLevel('changer', T), false);
});

// ── handler level: REAL handler + REAL SQL, MOCKED AI ──────────────────────────────────────────────────────────────────
test('beginner AI Polish through the real handler and real SQL (AI provider mocked)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_beginner');
  await db.admin(H.SUPABASE_DEFAULT_PRIVS);
  await H.liveState(db); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2); await H.applyMigration(db, H.MIG3); await H.applyMigration(db, H.MIG4);
  const hs = loadHandlers(db.pool('service_role', 40));
  const ai = installAi({});
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'mock', TAILOR_TOKEN_SECRET: SECRET, AI_TIMEOUT_MS: '1000' });
  let seq = 0;
  const seed = async (uses = 5) => { const c = `FG-B${String(++seq).padStart(3, '0')}-BBBB`; await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const uses = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const rsv = async (c) => (await db.admin('select status from license_reservations where code=$1 order by created_at', [c])).rows.map((x) => x.status);
  const copies = async (c) => (await db.admin('select count(*)::int n from result_recovery where code=$1', [c])).rows[0].n;
  const reset = () => { ai.mode = 'ok'; ai.delayMs = 0; ai.calls = 0; ai.polishPayload = null; ai.lastPrompt = ''; hs.polishModule._recent.clear(); hs.polishModule._nochange._events.clear(); };
  const polish = (code, resume, extra = {}) => hs.polish(post({ code, resume, target: 'Customer Service Associate', profile: 'first', ...extra }));
  const outOf = (b) => JSON.parse(b.result);
  const nothingChargedOrStored = async (c, n = 5) => { assert.equal(await uses(c), n); assert.equal(await copies(c), 0, 'no recovery copy for a result that was not charged'); assert.ok(!(await rsv(c)).includes('committed')); };

  await t.test('HONEST BEGINNER WORDING (Taylor Morgan, first resume, no work history): "entry-level" and a plain skills statement are applied FREE', async () => {
    reset(); const c = await seed();
    ai.polishPayload = edit((o) => { o.summary.tagline = ENTRY; o.summary.bullets = ['Communication and teamwork skills.']; });
    const r = await polish(c, TAYLOR); const b = parseBody(r);
    assert.equal(r.statusCode, 200); assert.equal(b.appliedFree, true); assert.equal(b.charged, false); assert.equal(b.points, 2); assert.equal(b.threshold, 3);
    const out = outOf(b); assert.equal(out.summary.tagline, ENTRY); assert.deepEqual(out.summary.bullets, ['Communication and teamwork skills.']); assert.deepEqual(out.summary.skills, TAYLOR.summary.skills);
    assert.deepEqual(out.experience, [], 'no job is invented for someone with none'); assert.deepEqual(b.withheld, []); assert.equal(b.tailorToken, undefined);
    await nothingChargedOrStored(c); assert.deepEqual(await rsv(c), ['released']);
    assert.match(ai.lastPrompt, /ENTRY-LEVEL WORDING/);
  });

  await t.test('ENTRY-LEVEL NEEDS THE EXPLICIT CHOICE AND NO WORK HISTORY: without it the headline is put back (reason given), the plain skills line is still applied free', async () => {
    reset(); let c = await seed();
    ai.polishPayload = edit((o) => { o.summary.tagline = ENTRY; o.summary.bullets = ['Communication and teamwork skills.']; });
    let b = parseBody(await polish(c, TAYLOR, { profile: undefined }));
    assert.equal(outOf(b).summary.tagline, TAYLOR.summary.tagline); assert.deepEqual(outOf(b).summary.bullets, ['Communication and teamwork skills.']);
    assert.equal(b.withheld[0].label, 'Headline'); assert.match(b.withheld[0].reasons.join(), /level of experience you did not state/); assert.equal(b.charged, false); await nothingChargedOrStored(c);
    assert.doesNotMatch(ai.lastPrompt, /ENTRY-LEVEL WORDING/);
    reset(); c = await seed();                                            // an applicant WITH work history who picked "first resume" anyway: never entry-level
    ai.polishPayload = edit((o) => { o.summary.tagline = 'Entry-level cashier'; });
    b = parseBody(await polish(c, MARIA, { target: 'cashier' }));
    assert.equal(b.noChange, true); assert.equal(b.reason, 'flagged'); assert.equal(JSON.stringify(b).includes('Entry-level cashier'), false); await nothingChargedOrStored(c);
    assert.doesNotMatch(ai.lastPrompt, /ENTRY-LEVEL WORDING/);
  });

  await t.test('FREE COSMETIC CHANGES: capitals and full stops only change nothing, cost nothing, store nothing', async () => {
    reset(); const c = await seed();
    ai.polishPayload = edit((o) => { o.summary.tagline = o.summary.tagline.toLowerCase().replace(/\.$/, ''); o.summary.bullets = o.summary.bullets.map((x) => x.toUpperCase()); });
    const b = parseBody(await polish(c, TAYLOR));
    assert.equal(b.noChange, true); assert.equal(b.reason, 'unchanged'); assert.equal(b.points, 0); assert.equal(b.charged, false); assert.equal(b.result, undefined);
    await nothingChargedOrStored(c); assert.deepEqual(await rsv(c), ['released']);
  });

  await t.test('DUPLICATED SKILLS: a new line that only repeats the skills list is dropped and never charged', async () => {
    reset(); let c = await seed();
    ai.polishPayload = edit((o) => { o.summary.bullets.push('Communication, teamwork, organization and customer service skills.'); });
    let b = parseBody(await polish(c, TAYLOR));
    assert.equal(b.noChange, true); assert.equal(b.reason, 'unchanged'); assert.equal(b.charged, false); assert.equal(b.result, undefined, 'nothing is applied'); await nothingChargedOrStored(c);
    reset(); c = await seed();                                              // the same repeat riding along with a small real fix: the fix is applied free, the repeat is not
    ai.polishPayload = edit((o) => { o.summary.tagline = ENTRY; o.summary.bullets.push('Communication, teamwork, organization and customer service skills.'); });
    b = parseBody(await polish(c, TAYLOR));
    assert.equal(b.appliedFree, true); assert.equal(b.charged, false); assert.equal(outOf(b).summary.tagline, ENTRY); assert.deepEqual(outOf(b).summary.bullets, TAYLOR.summary.bullets, 'no duplicate line reaches the resume');
    await nothingChargedOrStored(c);
    reset(); c = await seed();                                              // repeating the skills in a new SKILLS entry, and a repeated fact in a job
    ai.polishPayload = edit((o) => { o.summary.skills.push('Teamwork and communication'); });
    b = parseBody(await polish(c, TAYLOR)); assert.equal(b.noChange, true); assert.equal(b.charged, false); await nothingChargedOrStored(c);
  });

  await t.test('GENUINELY MEANINGFUL REWRITES ARE STILL CHARGED, exactly once, with exactly one recovery copy', async () => {
    reset(); let c = await seed();                                          // Taylor: the headline gains the level AND the strengths THEY listed = a real rewrite (3 points)
    ai.polishPayload = edit((o) => { o.summary.tagline = 'Seeking an entry-level Customer Service Associate position, with communication, teamwork and organization skills.'; });
    let r = await polish(c, TAYLOR); let b = parseBody(r);
    assert.equal(r.statusCode, 200); assert.equal(b.charged, true); assert.equal(b.points, 3); assert.equal(b.usesRemaining, 4); assert.ok(b.tailorToken);
    assert.equal(outOf(b).summary.tagline, 'Seeking an entry-level Customer Service Associate position, with communication, teamwork and organization skills.');
    assert.equal(await uses(c), 4); assert.deepEqual(await rsv(c), ['committed']); assert.equal(await copies(c), 1);
    reset(); c = await seed();                                              // Jordan: typos, tense and a vague word put right on volunteer lines + the level on the headline
    ai.polishPayload = edit((o) => { o.summary.tagline = 'Seeking an entry-level cafe position.'; o.volunteer[0].bullets = ['Help sort cans and other items on Saturdays', 'Help hand out bags to people']; });
    r = await polish(c, JORDAN, { target: 'cafe' }); b = parseBody(r);
    assert.equal(b.charged, true); assert.ok(b.points >= 3); assert.equal(await uses(c), 4); assert.equal(await copies(c), 1); assert.deepEqual(outOf(b).volunteer[0].bullets, ['Help sort cans and other items on Saturdays', 'Help hand out bags to people']);
    assert.equal(outOf(b).volunteer[0].organization, 'Riverside Food Pantry'); assert.equal(outOf(b).volunteer[0].start, '2025');
  });

  await t.test('INVENTED OR EXAGGERATED QUALIFICATIONS ARE WITHHELD: nothing applied, nothing charged, the invented text is never handed back', async () => {
    const cases = [
      ['an invented goal', TAYLOR, edit((o) => { o.summary.tagline = 'Seeking an entry-level Customer Service Associate position with opportunities to develop professional skills.'; }), 'opportunities to develop'],
      ['invented traits', TAYLOR, edit((o) => { o.summary.tagline = 'Reliable, eager team player seeking an entry-level Customer Service Associate position.'; }), 'Reliable, eager'],
      ['a skill turned into a result', TAYLOR, edit((o) => { o.summary.bullets = ['Resolved customer questions using communication and teamwork.']; }), 'Resolved customer questions'],
      ['leadership', TAYLOR, edit((o) => { o.summary.bullets = ['Led a team of cashiers.']; }), 'Led a team'],
      ['a certification', TAYLOR, edit((o) => { o.summary.bullets = ['Certified in customer service.']; }), 'Certified in customer service'],
      ['a measurable result', TAYLOR, edit((o) => { o.summary.bullets = ['Helped 200 customers daily with communication and teamwork.']; }), '200 customers'],
      ['an invented job', TAYLOR, edit((o) => { o.experience = [{ title: 'Cashier', company: 'Fictional Corner Store', location: '', start: '2025', end: '2026', summary: '', bullets: ['Handled customer questions'] }]; }), 'Corner Store'],
      ['a wish to learn turned into a skill', SAM, edit((o) => { o.summary.tagline = 'Skilled in Excel, seeking an office assistant position.'; }), 'Skilled in Excel'],
      ['a wish to learn turned into proficiency', SAM, edit((o) => { o.summary.tagline = 'Proficient in Excel, seeking an office assistant position.'; }), 'Proficient in Excel'],
      ['a skill added because the target job implies it', SAM, edit((o) => { o.summary.skills = ['Typing', 'Teamwork', 'Excel']; }), 'Excel']
    ];
    for (const [label, resume, payload, needle] of cases) {
      reset(); const c = await seed(); ai.polishPayload = payload;
      const r = await polish(c, resume, { target: resume === SAM ? 'Office Assistant' : 'Customer Service Associate' }); const b = parseBody(r);
      assert.equal(r.statusCode, 200, label); assert.equal(b.noChange, true, label); assert.ok(['flagged', 'unchanged'].includes(b.reason), label); assert.equal(b.charged, false, label); assert.equal(b.result, undefined, label);
      if (b.reason === 'flagged') assert.ok(b.withheld.length >= 1, label);            // an invented JOB is discarded outright (the customer's own list is kept), so nothing is left to report assert.equal(JSON.stringify(b).includes(needle), false, `${label}: the invented text is not handed out`);
      await nothingChargedOrStored(c);
    }
  });

  await t.test('NO REGRESSION FOR EXPERIENCED APPLICANTS: ordinary fixes score and charge as before and the entry-level wording is not in their prompt', async () => {
    reset(); const c = await seed();
    ai.polishPayload = edit((o) => { o.summary.tagline = 'Cashier with experience'; o.experience[0].bullets = ['Ran the register', 'Helped customers find products', 'Handled returns']; });
    const r = await polish(c, MARIA, { target: 'cashier', profile: 'experienced' }); const b = parseBody(r);
    assert.equal(b.charged, true); assert.ok(b.points >= 3); assert.equal(await uses(c), 4); assert.equal(await copies(c), 1);
    assert.deepEqual(outOf(b).experience[0].bullets, ['Ran the register', 'Helped customers find products', 'Handled returns']); assert.equal(outOf(b).experience[0].title, 'Cashier'); assert.equal(outOf(b).experience[0].company, 'Fictional Fresh Market');
    assert.doesNotMatch(ai.lastPrompt, /ENTRY-LEVEL WORDING/); assert.match(ai.lastPrompt, /Do not describe the person as entry-level/);
    reset(); const d = await seed();                                      // one typo only: still free, still applied
    ai.polishPayload = edit((o) => { o.summary.tagline = 'Cashier with experience'; });
    const f = parseBody(await polish(d, MARIA, { target: 'cashier', profile: 'experienced' })); assert.equal(f.appliedFree, true); assert.equal(f.charged, false); assert.equal(await uses(d), 5);
  });

  await t.test('DUPLICATE-CHARGE PROTECTION AND RECOVERY ARE UNCHANGED: a retried charged request returns the same result, one charge, one copy; a restore costs nothing', async () => {
    reset(); const c = await seed();
    ai.polishPayload = edit((o) => { o.summary.tagline = 'Seeking an entry-level Customer Service Associate position, with communication, teamwork and organization skills.'; });
    const first = await polish(c, TAYLOR, { requestId: 'req-beginner-1' }); const b1 = parseBody(first);
    assert.equal(b1.charged, true); assert.equal(await uses(c), 4); assert.equal(ai.calls, 1);
    const again = await polish(c, TAYLOR, { requestId: 'req-beginner-1' }); const b2 = parseBody(again);
    assert.equal(again.statusCode, 200); assert.equal(b2.result, b1.result); assert.equal(await uses(c), 4, 'a retry is not a second charge'); assert.equal(ai.calls, 1, 'and not a second AI call');
    assert.equal(await copies(c), 1, 'exactly one recovery copy for one charged step');
    const rows = (await db.admin("select status, count(*)::int n from license_reservations where code=$1 group by status", [c])).rows; assert.deepEqual(rows.map((x) => [x.status, x.n]), [['committed', 1]]);
    reset(); const d = await seed();                                      // two simultaneous identical requests: one charge
    ai.delayMs = 150; ai.polishPayload = edit((o) => { o.summary.tagline = 'Seeking an entry-level Customer Service Associate position, with communication, teamwork and organization skills.'; });
    const pair = await Promise.all([polish(d, TAYLOR, { requestId: 'req-beginner-2' }), polish(d, TAYLOR, { requestId: 'req-beginner-2' })]);
    assert.ok(pair.some((x) => parseBody(x).charged === true)); assert.equal(await uses(d), 4, 'two simultaneous requests are one charge'); assert.equal(await copies(d), 1);
  });
});
