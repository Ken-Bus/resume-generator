// The owner-approved collective-improvement rule (netlify/functions/_lib/scoring.js), judged on before/after pairs of fictional text.
// Pure functions: no database, no AI. The same table is exercised through the real handler and real SQL in collective-charge.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { score, THRESHOLD } = require('../../netlify/functions/_lib/scoring');
const I = require('../../netlify/functions/_lib/integrity');
const Core = require('../../resume-core.js');
const { C } = require('./quality-corpus');

const mk = (bullets, extra = {}) => ({ name: 'Test Person', summary: { tagline: '', bullets: [], skills: [] }, experience: [{ title: 'Clerk', company: 'Fictional Shop', summary: '', bullets }], education: [], certifications: [], projects: [], volunteer: [], awards: [], ...extra });
const BASE = ['Rang up purchases for custmers', 'Counted the cash drawer at clossing', 'Stocked shelves with new merchandize', 'Answered questons about prices', 'Cleaned the registar area', 'Greeted customers at the entrence'];
const FIXED = ['Rang up purchases for customers', 'Counted the cash drawer at closing', 'Stocked shelves with new merchandise', 'Answered questions about prices', 'Cleaned the register area', 'Greeted customers at the entrance'];
const fixFirst = (n) => FIXED.map((b, i) => (i < n ? b : BASE[i]));
const pts = (a, b) => score(Core.clean(a), Core.clean(b));

// [label, before, after, points, charged]   (null points = not asserted exactly)
const CASES = [
  ['one typo fixed', mk(BASE), mk(fixFirst(1)), 1, false],
  ['two typos fixed', mk(BASE), mk(fixFirst(2)), 2, false],
  ['THREE typos fixed', mk(BASE), mk(fixFirst(3)), 3, true],
  ['SIX typos fixed', mk(BASE), mk(FIXED), 6, true],
  ['one real rewrite', mk(['worked on the register and helped customers', 'Counted money']), mk(['Operated the register and helped customers', 'Counted money']), 3, true],
  ['one vague verb made specific', mk(['Did the register', 'Counted money']), mk(['Operated the register', 'Counted money']), 1, false],
  ['three vague words made specific', mk(['Did the register', 'Moved stuff in the back', 'Counted things at night']), mk(['Operated the register', 'Moved boxes in the back', 'Counted items at night']), 3, true],
  ['five synonym swaps ("Helped" -> "Assisted")', mk([0, 1, 2, 3, 4].map((i) => `Helped customer group ${i}`)), mk([0, 1, 2, 3, 4].map((i) => `Assisted customer group ${i}`)), 0, false],
  ['five single words added ("donated")', mk([0, 1, 2, 3, 4].map((i) => `Sorted food box ${i}`)), mk([0, 1, 2, 3, 4].map((i) => `Sorted donated food box ${i}`)), 0, false],
  ['capitals and full stops on every line', mk([...Array(12).keys()].map((i) => `packed box number ${i}`)), mk([...Array(12).keys()].map((i) => `Packed box number ${i}.`)), 0, false],
  ['two repeated lines removed', mk(['Made bread', 'Made bread', 'Made bread', 'Cleaned the oven']), mk(['Made bread', 'Cleaned the oven']), 2, false],
  ['three repeated lines removed', mk(['Made bread', 'made the bread', 'Made bread', 'Made bread', 'Cleaned the oven']), mk(['Made bread', 'Cleaned the oven']), 3, true],
  ['a list re-ordered', mk(['Packed boxes', 'Counted stock', 'Cleaned the dock']), mk(['Cleaned the dock', 'Packed boxes', 'Counted stock']), 0, false],
  ['a run-on split into three bullets', mk(['I load trucks and unloaded them and also i count the stock every week then I reported damaged boxs to the supervisor']), mk(['Loaded and unloaded trucks', 'Counted stock every week', 'Reported damaged boxes to the supervisor']), null, true],
  ['padding: one clear line split in two', mk(['Loaded and unloaded trucks']), mk(['Loaded trucks', 'Unloaded trucks']), 2, false],
  ['nothing changed', mk(BASE), mk(BASE), 0, false]
];
test('the rule: every reference case scores and charges exactly as approved', () => {
  for (const [label, a, b, p, charged] of CASES) {
    const r = pts(a, b);
    assert.equal(r.charge, charged, `${label}: charge (${r.points} points ${JSON.stringify(r.by)})`);
    if (p !== null) assert.equal(r.points, p, `${label}: points`);
  }
});

test('boundaries: 0, 1, 2 points are free; 3 and more are charged; the threshold is exactly 3', () => {
  assert.equal(THRESHOLD, 3);
  const by = (n) => pts(mk(BASE), mk(fixFirst(n)));
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => [by(n).points, by(n).charge]), [[0, false], [1, false], [2, false], [3, true], [4, true]]);
});

test('the same underlying fix is never counted twice', () => {
  // "custmers" put right on five different lines is ONE correction
  const five = [...Array(5).keys()].map((i) => `Rang up item ${i} for custmers`);
  const fixed = five.map((b) => b.replace('custmers', 'customers'));
  const r = pts(mk(five), mk(fixed));
  assert.equal(r.points, 1); assert.equal(r.charge, false);
  // a correction inside a line that was restructured is part of that rewrite, not an extra point
  const rewritten = pts(mk(['I load trucks and unloaded them and also i count the stock every week then I reported damaged boxs to the supervisor']), mk(['Loaded and unloaded trucks', 'Counted stock every week', 'Reported damaged boxes to the supervisor']));
  assert.ok(rewritten.points <= 4, `run-on split should not also earn a point per typo (${rewritten.points})`);
});

test('a line that fixes several misspellings scores each distinct correction once, not as a free "rewrite"', () => {
  const r = pts(mk(['ring up custmers at the registar']), mk(['Ring up customers at the register']));
  assert.equal(r.points, 2); assert.equal(r.charge, false);
  const r3 = pts(mk(['ring up custmers at the registar and clenup the drawr']), mk(['Ring up customers at the register and clean up the drawer']));
  assert.ok(r3.points >= 3 && r3.charge, `four corrections in one line are worth a generation (${r3.points})`);
});

test('the AI cannot manufacture points: they come only from differences against the customer\'s own words', () => {
  const A = Core.clean(mk(['Rang up purchases for customers', 'Counted the cash drawer at closing']));
  assert.equal(score(A, A).points, 0);
  const padded = Core.clean(mk(['Rang up purchases for customers', 'Counted the cash drawer at closing', 'Rang up purchases for customers', 'Counted the cash drawer at closing']));
  assert.ok(score(A, padded).points <= 2, 'duplicated lines are not improvements');
  // synonyms of plain verbs in several places are still worth nothing
  const syn = score(Core.clean(mk(['Took orders and made food', 'Helped customers and cleaned tables'])), Core.clean(mk(['Handled orders and prepared food', 'Assisted customers and wiped tables'])));
  assert.equal(syn.points, 0);
});

test('only ACCEPTED text earns points: a line the guard withheld never counts, however impressive', () => {
  const before = Core.clean(mk(['Rang up purchases for custmers', 'Counted the cash drawer at clossing', 'Cleaned the registar area']));
  const ai = Core.clean(mk(['Rang up purchases for customers', 'Supervised a team of 12 cashiers, increasing sales by 40%', 'Cleaned the register area']));   // one invention among two honest fixes
  const g = I.guardResume(before, ai, { mode: 'polish', vocabulary: 'retail' });
  assert.equal(g.withheld.length >= 1, true, 'the invention is withheld');
  const r = score(before, g.resume);
  assert.equal(r.points, 2, 'the two honest fixes are worth 2; the withheld invention is worth nothing');
  assert.equal(r.charge, false);
});

test('on the writing-quality personas: the ideal edit of every resume that needs one is worth a generation; a clear resume is worth nothing', () => {
  const table = {};
  for (const [name, c] of Object.entries(C)) table[name] = c.after ? pts(c.before, c.after) : pts(c.before, c.before);
  for (const name of ['firstPoor', 'warehouse', 'retail', 'changer', 'gap', 'disorganized', 'incomplete', 'spellingOnly']) assert.equal(table[name].charge, true, `${name} (${table[name].points})`);
  assert.equal(table.polished.points, 0); assert.equal(table.polished.charge, false);
});

test('scoring never throws on odd input', () => {
  assert.doesNotThrow(() => score(null, undefined));
  assert.doesNotThrow(() => score({}, { experience: [{ bullets: [null, 5, { x: 1 }] }] }));
  assert.equal(score({}, {}).points, 0);
});
