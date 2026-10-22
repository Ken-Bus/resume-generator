// Fabrication guard for tailoring: facts are restored, unsupported claims are flagged, accounting is untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { reconcile, assessChange } = require(path.join('..', '..', 'netlify', 'functions', '_lib', 'integrity'));
const { H, loadHandlers, post, parseBody, installAi, GOOD_RESUME } = require('./harness');

const ORIGINAL = {
  name: 'Michael Johnson', contact: { phone: '(555) 010-0101', email: 'mj@example.com', location: 'Dayton, OH', linkedin: '', website: '' },
  summary: { tagline: 'Warehouse worker', bullets: ['Eight years on the loading dock'], skills: ['Forklift safety', 'Teamwork'] },
  experience: [{ title: 'Warehouse Associate', company: 'Fictional Freight Co', location: 'Dayton, OH', start: '2016', end: 'Present', summary: '',
    bullets: ['Loaded and unloaded trucks', 'Checked orders for accuracy'] }],
  education: [{ degree: 'High School Diploma', school: 'Oakwood High', location: '', date: '2016', honors: '' }],
  certifications: [{ name: 'Forklift Safety Course', org: 'Fictional Safety Council', date: '2018' }],
  projects: [], volunteer: [], awards: ['Employee of the Month, May 2021']
};
const clone = (o) => JSON.parse(JSON.stringify(o));

test('facts the AI changed or invented are restored from the customer resume', () => {
  const out = clone(ORIGINAL);
  out.name = 'Mike Johnston'; out.contact.email = 'other@example.com';
  out.experience[0].title = 'Senior Warehouse Manager'; out.experience[0].company = 'Mega Corp'; out.experience[0].start = '2010';
  out.experience.push({ title: 'Invented Role', company: 'Invented Co', start: '2001', end: '2005', bullets: ['x'] });
  out.education[0].degree = 'MBA'; out.certifications.push({ name: 'CDL Class A', org: 'DMV', date: '2020' });
  out.awards = ['Nobel Prize'];
  const { resume } = reconcile(ORIGINAL, out);
  assert.equal(resume.name, 'Michael Johnson');
  assert.equal(resume.contact.email, 'mj@example.com');
  assert.equal(resume.experience.length, 1);
  assert.deepEqual([resume.experience[0].title, resume.experience[0].company, resume.experience[0].start, resume.experience[0].end], ['Warehouse Associate', 'Fictional Freight Co', '2016', 'Present']);
  assert.deepEqual(resume.education, ORIGINAL.education);
  assert.deepEqual(resume.certifications, ORIGINAL.certifications);
  assert.deepEqual(resume.awards, ORIGINAL.awards);
});

test('an entry the AI dropped is kept; rewritten bullets are allowed', () => {
  const out = clone(ORIGINAL); out.experience = [];
  assert.equal(reconcile(ORIGINAL, out).resume.experience[0].title, 'Warehouse Associate');
  const out2 = clone(ORIGINAL); out2.experience[0].bullets = ['Loaded and unloaded freight trucks safely'];
  const r = reconcile(ORIGINAL, out2);
  assert.deepEqual(r.resume.experience[0].bullets, ['Loaded and unloaded freight trucks safely']);
  assert.deepEqual(r.unverified, []);
});

test('invented statistics are flagged (the cycle-count case), but numbers from the original are not', () => {
  const out = clone(ORIGINAL);
  out.experience[0].bullets = ['Performed 500 cycle counts per week with 99.8% accuracy', 'Worked on the dock for 8 years since 2016'];
  out.summary.bullets = ['Eight years on the loading dock'];
  const { unverified } = reconcile(ORIGINAL, out);
  assert.equal(unverified.length, 1);
  assert.match(unverified[0].text, /cycle counts/);
  assert.match(unverified[0].reasons.join(' '), /500/);
});

test('invented leadership and credential wording is flagged; wording already in the original is not', () => {
  const out = clone(ORIGINAL);
  out.experience[0].bullets = ['Supervised a team of loaders', 'Certified OSHA safety trainer', 'Loaded and unloaded trucks'];
  const f = reconcile(ORIGINAL, out).unverified.map((u) => u.text);
  assert.deepEqual(f, ['Supervised a team of loaders', 'Certified OSHA safety trainer']);
  const orig2 = clone(ORIGINAL); orig2.certifications[0].name = 'Forklift Safety Certification';
  const out2 = clone(orig2); out2.experience[0].bullets = ['Completed forklift safety certification'];
  assert.equal(reconcile(orig2, out2).unverified.length, 0);       // "certif..." appears in the original resume
  const out3 = clone(ORIGINAL); out3.experience[0].bullets = ['Completed a forklift safety certification'];
  assert.equal(reconcile(ORIGINAL, out3).unverified.length, 1);    // the original only said "Course": claiming a certification is new
});

test('new skills are flagged; existing skills are not', () => {
  const out = clone(ORIGINAL); out.summary.skills = ['Teamwork', 'Salesforce', 'forklift safety'];
  const { unverified } = reconcile(ORIGINAL, out);
  assert.deepEqual(unverified.map((u) => u.text), ['Salesforce']);
});

test('never throws on odd AI output; always returns arrays', () => {
  for (const bad of [null, {}, { experience: 'x' }, { summary: 5, experience: [null, 1] }]) {
    const r = reconcile(ORIGINAL, bad);
    assert.ok(Array.isArray(r.unverified)); assert.ok(Array.isArray(r.resume.experience));
  }
  assert.doesNotThrow(() => reconcile(null, null));
  assert.doesNotThrow(() => reconcile({}, { experience: [{ bullets: 'not an array' }] }));
});

test('flags are capped', () => {
  const out = clone(ORIGINAL); out.experience[0].bullets = Array.from({ length: 200 }, (_, i) => `Handled ${1000 + i} orders`);
  assert.ok(reconcile(ORIGINAL, out).unverified.length <= 40);
});

// ── end to end through the real handler and real SQL ─────────────────────────────
test('tailor-resume: facts restored, unsupported lines WITHHELD (put back to the original), accounting identical to before', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_integrity');
  await db.admin(H.SUPABASE_DEFAULT_PRIVS);
  await H.liveState(db); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2);
  const code = 'FG-INTG-0001';
  await H.seed(db, [{ code, uses: 5, assigned: true }]);
  const hs = loadHandlers(db.pool('service_role', 10));
  const ai = installAi({});
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'mock', AI_TIMEOUT_MS: '1000',
    TAILOR_TOKEN_SECRET: 'test-secret-test-secret-test-secret-0123456789' });

  const paid = parseBody(await hs.parse(post({ code, resumeText: 'Jordan Ellis, retail associate' })));
  assert.ok(paid.tailorToken);
  const usesAfterPaid = (await db.admin('select uses_remaining u from licenses where code=$1', [code])).rows[0].u;
  assert.equal(usesAfterPaid, 4);

  const tampered = clone(ORIGINAL);
  tampered.name = 'Totally Different'; tampered.experience[0].company = 'Mega Corp';
  tampered.experience[0].bullets = ['Performed 500 cycle counts per week', 'Loaded and unloaded trucks'];
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text',
    text: JSON.stringify({ resume: tampered, matchSummary: { matchedKeywords: ['trucks'], missingKeywords: [], notes: 'ok' } }) }] }) });
  try {
    const res = await hs.tailor(post({ resumeData: ORIGINAL, jobDescription: 'Warehouse associate', tailorToken: paid.tailorToken }));
    assert.equal(res.statusCode, 200);
    const body = parseBody(res);
    const result = JSON.parse(body.result);
    assert.equal(result.resume.name, 'Michael Johnson');
    assert.equal(result.resume.experience[0].company, 'Fictional Freight Co');
    assert.deepEqual(body.unverified, []);                                              // nothing unsupported is left in the resume
    assert.equal(body.withheld.length, 1);
    assert.match(body.withheld[0].reasons.join(), /number not in your resume/); assert.match(body.withheld[0].label, /Job: Warehouse Associate, bullet 1/);
    assert.deepEqual(result.resume.experience[0].bullets, ORIGINAL.experience[0].bullets);   // the invented "500 cycle counts" line is gone, the customer's line is back
    assert.equal(JSON.stringify(body).includes('500 cycle counts'), false);                  // and the AI's text is not handed out in the report
    assert.equal(body.tailorRunsRemaining, 4);
  } finally { global.fetch = realFetch; }
  // Tailoring is still free: the license balance did not move, and exactly one tailoring run was recorded.
  assert.equal((await db.admin('select uses_remaining u from licenses where code=$1', [code])).rows[0].u, 4);
  assert.equal((await db.admin("select tailor_count c from license_reservations where code=$1 and status='committed'", [code])).rows[0].c, 1);
  await db.drop?.();
});

// ── AI Polish: did the result actually change the customer's wording? (observation only, no accounting) ──────────────
const TAYLOR = {
  name: 'Taylor Rivera', contact: { email: 'taylor.rivera@example.com' }, summary: { tagline: 'Seeking a customer service position', bullets: [], skills: ['Teamwork'] },
  experience: [], education: [{ degree: 'High School Diploma', school: 'Oakwood High School', date: '2026' }], certifications: [], volunteer: [], awards: [],
  projects: [{ name: 'School food drive', description: 'collected cans for the pantry', bullets: ['asked classmates to donate cans', 'sorted and counted the cans'] }]
};

test('assessChange: an unchanged result reports nothing reworded; real rewording, cosmetic-only edits and added/removed lines are told apart', () => {
  assert.deepEqual(assessChange(TAYLOR, clone(TAYLOR)), { reworded: 0, cosmetic: 0, unchanged: 5, dropped: 0 });
  const better = clone(TAYLOR); better.projects[0].bullets[0] = 'Asked classmates to donate canned food';
  assert.deepEqual(assessChange(TAYLOR, better), { reworded: 1, cosmetic: 0, unchanged: 4, dropped: 0 });
  const cosmetic = clone(TAYLOR); cosmetic.projects[0].bullets = ['Asked classmates to donate cans.', '  sorted and counted the cans '];
  assert.deepEqual(assessChange(TAYLOR, cosmetic), { reworded: 0, cosmetic: 1, unchanged: 4, dropped: 0 });          // capital + full stop only; the 2nd line differs by spaces alone
  const added = clone(TAYLOR); added.projects[0].bullets.push('Delivered the cans to the pantry');
  assert.equal(assessChange(TAYLOR, added).reworded, 1);
  const dropped = clone(TAYLOR); dropped.projects[0].bullets.pop();
  assert.deepEqual(assessChange(TAYLOR, dropped), { reworded: 0, cosmetic: 0, unchanged: 4, dropped: 1 });   // deleting text is not an improvement: it never counts toward a charge
  assert.deepEqual(assessChange(null, undefined), { reworded: 0, cosmetic: 0, unchanged: 0, dropped: 0 });            // junk in, no crash
});

test('assessChange ignores facts the guard restores (name, schools, dates): only wording the customer can see counts', () => {
  const out = clone(TAYLOR); out.name = 'Someone Else'; out.education[0].school = 'Invented University';
  assert.equal(assessChange(TAYLOR, out).reworded, 0);
});

test('polish only (keepBlankedText): a reply that blanks an entry\'s description or bullets cannot erase the customer\'s own text; Tailor is unchanged', () => {
  const out = clone(TAYLOR); out.projects[0].description = ''; out.projects[0].bullets = [];
  const polished = reconcile(TAYLOR, out, { keepBlankedText: true }).resume;
  assert.equal(polished.projects[0].description, 'collected cans for the pantry');
  assert.deepEqual(polished.projects[0].bullets, ['asked classmates to donate cans', 'sorted and counted the cans']);
  const omitted = clone(TAYLOR); delete omitted.projects[0].description; delete omitted.projects[0].bullets;
  assert.equal(reconcile(TAYLOR, omitted, { keepBlankedText: true }).resume.projects[0].description, 'collected cans for the pantry');
  const tailored = reconcile(TAYLOR, out).resume;                                                           // Tailor passes no option: behaviour as before
  assert.equal(tailored.projects[0].description, ''); assert.deepEqual(tailored.projects[0].bullets, []);
  const rewritten = clone(TAYLOR); rewritten.projects[0].description = 'Collected canned food for the pantry.';
  assert.equal(reconcile(TAYLOR, rewritten, { keepBlankedText: true }).resume.projects[0].description, 'Collected canned food for the pantry.');   // real rewording is kept
});
