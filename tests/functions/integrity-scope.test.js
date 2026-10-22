// AI Polish factual integrity, entry-scoped (found in a real Sonnet 5.5 run on commit 9121379, fictional Taylor Rivera):
//   * a blank project description became "Collected donated food for families in the community."
//   * "Asked classmates to donate canned food" gained "for families in the community" (a beneficiary from ANOTHER entry)
//   * "Helped organize food for pickup" became "Organized donated food for pickup" (helper -> organizer)
// and none of it was flagged, because every check compared a line with the vocabulary of the WHOLE resume. These tests are
// deterministic (no AI): they pin what is flagged and, as importantly, what is NOT, so useful faithful wording is preserved.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const FUNCS = path.join(__dirname, '..', '..', 'netlify', 'functions');
const { reconcile, assessChange, scopedReasons } = require(path.join(FUNCS, '_lib', 'integrity'));
const Core = require(path.join('..', '..', 'resume-core.js'));
const clone = (o) => JSON.parse(JSON.stringify(o));

// Fictional. The project mentions nothing about families or a community; ANOTHER entry (and its organization name) does.
const TAYLOR = Core.clean({
  name: 'Taylor Rivera', contact: { email: 'taylor.rivera@example.com' },
  summary: { tagline: 'Seeking a customer service position', bullets: [], skills: ['Teamwork', 'Customer service'] },
  education: [{ degree: 'High School Diploma', school: 'Oakwood High School', date: '2026' }],
  projects: [{ name: 'School Food Drive', description: '', bullets: ['Asked classmates to donate canned food', 'Helped organize food for pickup'] }],
  volunteer: [{ title: 'Volunteer', organization: 'Community Food Pantry', start: '2025', end: 'Present', bullets: ['Packed grocery boxes on Saturdays', 'Greeted families as they arrived'] }]
});
const polishCheck = (src, edit, opts = {}) => { const out = clone(src); edit(out); return reconcile(src, out, { vocabulary: 'customer service', keepBlankedText: true, entryScope: true, ...opts }); };
const flagged = (r) => Object.fromEntries(r.unverified.map((u) => [u.where, u.reasons.join(' | ')]));

test('THE REPORTED CASE: all three problems are flagged, even though the words exist elsewhere in the resume', () => {
  const r = polishCheck(TAYLOR, (o) => {
    o.projects[0].description = 'Collected donated food for families in the community.';
    o.projects[0].bullets = ['Asked classmates to donate canned food for families in the community.', 'Organized donated food for pickup.'];
  });
  const f = flagged(r);
  assert.match(f['projects.0.description'], /added where you wrote nothing/);                          // blank field filled in by the AI
  assert.match(f['projects.0.description'], /who benefited is not in this entry: “families”/);          // beneficiary borrowed from the volunteer entry
  assert.match(f['projects.0.description'], /who benefited is not in this entry: “community”/);
  assert.match(f['projects.0.bullets.0'], /who benefited is not in this entry: “families”/);
  assert.match(f['projects.0.bullets.1'], /your role changed: you wrote that you helped with this, but it now says “organized”/);   // helper -> organizer
  assert.equal(r.unverified.length, 3);
  assert.ok(r.unverified.every((u) => u.kind === 'claim'));                                             // customer must confirm each
  // Warnings only: the wording is kept (the customer decides), and it still counts as a meaningful change
  assert.equal(r.resume.projects[0].bullets[1], 'Organized donated food for pickup.'); assert.ok(assessChange(TAYLOR, r.resume).reworded >= 3);
});

test('before this fix the same output passed silently (and Tailor, which does not use the scoped checks, behaves exactly as before)', () => {
  const out = clone(TAYLOR); out.projects[0].description = 'Collected donated food for families in the community.';
  out.projects[0].bullets = ['Asked classmates to donate canned food for families in the community.', 'Organized donated food for pickup.'];
  assert.deepEqual(reconcile(TAYLOR, out, { vocabulary: 'customer service' }).unverified, []);          // no entryScope option = the previous behaviour
});

test('unsupported beneficiaries: flagged unless the SAME entry names them', () => {
  const one = (line, entry) => { const src = clone(TAYLOR); if (entry) src.projects[0].description = entry; return flagged(polishCheck(src, (o) => { o.projects[0].bullets[0] = line; }))['projects.0.bullets.0']; };
  assert.match(one('Asked classmates to donate canned food for local families'), /who benefited.*“families”/);
  assert.match(one('Asked classmates to donate canned food to seniors'), /“seniors”/);
  assert.match(one('Asked classmates to donate canned food to support the community'), /“community”/);
  assert.match(one('Asked classmates to donate canned food to help people in need'), /“people in need”|“people”/);
  assert.match(one('Asked classmates to donate canned food for neighbors in the community'), /“neighbors”|“community”/);
  assert.equal(one('Asked classmates to donate canned food for local families', 'Collected canned food for local families'), undefined);   // the entry itself says so
  assert.equal(one('Asked classmates to donate canned food for a local pantry', 'Collected canned food for a local pantry'), undefined);    // a place is not a beneficiary claim
});

test('implied outcomes and impact: flagged unless the same entry states them', () => {
  const r = polishCheck(TAYLOR, (o) => { o.projects[0].bullets = ['Asked classmates to donate canned food, resulting in a full pantry', 'Helped organize food for pickup, ensuring everyone received it']; });
  const f = flagged(r);
  assert.match(f['projects.0.bullets.0'], /a result or impact that is not in this entry: “resulting in”/);
  assert.match(f['projects.0.bullets.1'], /“ensuring”/);
  for (const phrase of ['improving the drive', 'increasing donations', 'reducing waste', 'making a difference', 'which helped the pantry', 'having a positive impact']) {
    const g = flagged(polishCheck(TAYLOR, (o) => { o.projects[0].bullets[0] = `Asked classmates to donate canned food, ${phrase}`; }));
    assert.match(g['projects.0.bullets.0'] || '', /result or impact/, phrase);
  }
  const own = clone(TAYLOR); own.projects[0].bullets[0] = 'Asked classmates to donate canned food, which increased donations';
  assert.equal(flagged(polishCheck(own, (o) => { o.projects[0].bullets[0] = 'Asked classmates to donate canned food and increased donations'; }))['projects.0.bullets.0'], undefined);   // the customer said it
});

test('responsibility inflation: helped/assisted/was part of must not become organized/planned/ran/built/created/led', () => {
  const cases = [
    ['Helped organize food for pickup', 'Organized food for pickup', /“organized”/],
    ['Helped plan the school food drive', 'Planned the school food drive', /“planned”|“plan”/],
    ['Worked with the team to build the display', 'Built the display', /“built”/],
    ['Assisted with setting up the tables', 'Created the table setup', /“created”/],
    ['Was part of the team that coordinated pickups', 'Coordinated pickups', /“coordinated”/],
    ['Participated in running the sign-up sheet', 'Ran the sign-up sheet', /“ran”/]
  ];
  for (const [before, after, expect] of cases) {
    const src = clone(TAYLOR); src.projects[0].bullets = [before];
    const f = flagged(polishCheck(src, (o) => { o.projects[0].bullets = [after]; }));
    assert.match(f['projects.0.bullets.0'] || '', /your role changed|responsibility that is not in this entry/, `${before} -> ${after}`);   // hedged verb became ownership, or ownership appeared from nothing
    assert.match(f['projects.0.bullets.0'], expect, `${before} -> ${after}`);
  }
  // a responsibility that was never mentioned at all
  const src = clone(TAYLOR); src.projects[0].bullets = ['Stocked the shelves'];
  assert.match(flagged(polishCheck(src, (o) => { o.projects[0].bullets = ['Coordinated stocking of the shelves']; }))['projects.0.bullets.0'], /a responsibility that is not in this entry: “coordinated”/);
});

test('blank stays blank: text added where the customer wrote nothing is flagged, but leaving it blank is fine', () => {
  const f = flagged(polishCheck(TAYLOR, (o) => { o.projects[0].description = 'Collected canned food for a pantry drive'; }));
  assert.match(f['projects.0.description'], /added where you wrote nothing/);
  assert.deepEqual(polishCheck(TAYLOR, (o) => { o.projects[0].bullets[0] = 'Asked classmates to donate canned food.'; }).unverified, []);   // description stays blank, nothing added
  const noBullets = clone(TAYLOR); noBullets.volunteer[0].bullets = [];
  const g = flagged(polishCheck(noBullets, (o) => { o.volunteer[0].bullets = ['Welcomed visitors to the pantry']; }));
  assert.match(g['volunteer.0.bullets.0'], /added where you wrote nothing/);
});

test('FAITHFUL improvements are preserved: kept exactly, counted as meaningful, and NOT flagged', () => {
  const faithful = [
    ['keeps the hedge', (o) => { o.projects[0].bullets[1] = 'Helped organize the food pickup'; }],
    ['swaps one hedge for another', (o) => { o.projects[0].bullets[1] = 'Assisted with organizing food for pickup'; }],
    ['tidies and keeps the meaning', (o) => { o.projects[0].bullets[0] = 'Asked classmates to donate canned food for the food drive'; }],
    ['merges lines without inflating', (o) => { o.volunteer[0].bullets = ['Packed grocery boxes on Saturdays and greeted families as they arrived']; }],
    ['uses the entry\'s own beneficiary', (o) => { o.volunteer[0].bullets[1] = 'Greeted arriving families'; }],
    ['uses the organization name inside its own entry', (o) => { o.volunteer[0].bullets[0] = 'Packed grocery boxes for the community pantry on Saturdays'; }],
    ['capitals and full stop only', (o) => { o.projects[0].bullets[0] = 'Asked classmates to donate canned food.'; }]
  ];
  for (const [name, edit] of faithful) {
    const out = clone(TAYLOR); edit(out); const r = reconcile(TAYLOR, out, { vocabulary: 'customer service', keepBlankedText: true, entryScope: true });
    assert.deepEqual(r.unverified, [], `${name}: wrongly flagged: ${JSON.stringify(r.unverified)}`);
    assert.deepEqual(Core.clean(r.resume), Core.clean(out), `${name}: wording was altered`);
  }
  // the customer's own ownership verbs are theirs to keep or improve
  const owner = clone(TAYLOR); owner.projects[0].bullets = ['Organized the canned food by type', 'Planned pickup times with the pantry'];
  const r = polishCheck(owner, (o) => { o.projects[0].bullets = ['Organized the canned food by type for pickup', 'Planned pickup times with the pantry staff']; });
  assert.deepEqual(r.unverified, []);
});

test('experienced and career-changer examples: honest tightening passes, inflation and invented results are caught', () => {
  const MICHAEL = Core.clean({ name: 'Michael Johnson', summary: { tagline: 'Warehouse associate', bullets: [], skills: ['Forklift safety'] },
    experience: [{ title: 'Shift Lead', company: 'Fictional Freight Co', start: '2015', end: 'Present', bullets: ['showed new people how to use the pallet jack', 'checked orders for accuracy', 'helped the dock team load trucks'] }] });
  assert.deepEqual(polishCheck(MICHAEL, (o) => { o.experience[0].bullets = ['Showed new coworkers how to use the pallet jack', 'Checked orders for accuracy', 'Helped the dock team load trucks']; }).unverified, []);
  const bad = flagged(polishCheck(MICHAEL, (o) => { o.experience[0].bullets[2] = 'Organized the dock team loading trucks, improving efficiency'; }));
  assert.match(bad['experience.0.bullets.2'], /responsibility that is not in this entry: “organized”/); assert.match(bad['experience.0.bullets.2'], /result or impact/);   // 'organized' was never in the original line
  const PRIYA = Core.clean({ name: 'Priya Nair', summary: { tagline: '', bullets: [], skills: ['Keeping records'] },
    experience: [{ title: 'Warehouse Associate', company: 'Fictional Supply Co', start: '2018', end: '2026', bullets: ['answered customer questions by phone and in person', 'kept accurate records of shipments'] }] });
  assert.deepEqual(polishCheck(PRIYA, (o) => { o.experience[0].bullets = ['Answered customer questions by phone and in person', 'Kept accurate shipment records']; }).unverified, []);
  assert.match(flagged(polishCheck(PRIYA, (o) => { o.experience[0].bullets[1] = 'Kept accurate shipment records to support the community'; }))['experience.0.bullets.1'], /who benefited/);
});

test('scopedReasons never throws and returns nothing without a scope', () => {
  assert.deepEqual(scopedReasons('anything', undefined), []);
  for (const junk of [null, undefined, 42, {}, '']) assert.doesNotThrow(() => scopedReasons(junk, { text: '', lines: [], blank: false }));
});
