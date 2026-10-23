// What the PROPOSED collective charging rule would do, next to what the CURRENT rule does, on the same before/after pairs.
// Nothing here changes behaviour: the handler still uses the current rule. Fictional text only.
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../../netlify/functions/_lib/integrity');
const Core = require('../../resume-core.js');
const { points, THRESHOLD } = require('./collective-rule-spec');
const { C } = require('./quality-corpus');

const mk = (bullets, extra = {}) => ({ name: 'Test Person', summary: { tagline: '', bullets: [], skills: [] }, experience: [{ title: 'Clerk', company: 'Fictional Shop', summary: '', bullets }], education: [], certifications: [], projects: [], volunteer: [], awards: [], ...extra });
const current = (a, b) => I.assessChange(a, b).reworded > 0;           // today's rule: charged iff some line was REWRITTEN
const BASE = ['Rang up purchases for custmers', 'Counted the cash drawer at clossing', 'Stocked shelves with new merchandize', 'Answered questons about prices', 'Cleaned the registar area', 'Greeted customers at the entrence'];
const FIXED = ['Rang up purchases for customers', 'Counted the cash drawer at closing', 'Stocked shelves with new merchandise', 'Answered questions about prices', 'Cleaned the register area', 'Greeted customers at the entrance'];
const fixFirst = (n) => FIXED.map((b, i) => (i < n ? b : BASE[i]));

// [label, before, after, currentCharges, proposedCharges, proposedPoints]
const CASES = [
  ['one typo fixed', mk(BASE), mk(fixFirst(1)), false, false, 1],
  ['two typos fixed', mk(BASE), mk(fixFirst(2)), false, false, 2],
  ['THREE typos fixed', mk(BASE), mk(fixFirst(3)), false, true, 3],
  ['SIX typos fixed', mk(BASE), mk(FIXED), false, true, 6],
  ['one real rewrite', mk(['worked on the register and helped customers', 'Counted money']), mk(['Operated the register and helped customers', 'Counted money']), true, true, 3],
  ['one vague verb made specific', mk(['Did the register', 'Counted money']), mk(['Operated the register', 'Counted money']), false, false, 1],
  ['three vague words made specific', mk(['Did the register', 'Moved stuff in the back', 'Counted things at night']), mk(['Operated the register', 'Moved boxes in the back', 'Counted items at night']), false, true, 3],
  ['five synonym swaps ("Helped" -> "Assisted")', mk(Array(5).fill(0).map((_, i) => `Helped customer group ${i}`)), mk(Array(5).fill(0).map((_, i) => `Assisted customer group ${i}`)), false, false, 0],
  ['five single words added ("donated")', mk(Array(5).fill(0).map((_, i) => `Sorted food box ${i}`)), mk(Array(5).fill(0).map((_, i) => `Sorted donated food box ${i}`)), false, false, 0],
  ['capitals and full stops on every line', mk(Array(12).fill(0).map((_, i) => `packed box number ${i}`)), mk(Array(12).fill(0).map((_, i) => `Packed box number ${i}.`)), false, false, 0],
  ['two repeated lines removed', mk(['Made bread', 'Made bread', 'Made bread', 'Cleaned the oven']), mk(['Made bread', 'Cleaned the oven']), false, false, 2],
  ['three repeated lines removed', mk(['Made bread', 'made the bread', 'Made bread', 'Made bread', 'Cleaned the oven']), mk(['Made bread', 'Cleaned the oven']), false, true, 3],
  ['a list re-ordered', mk(['Packed boxes', 'Counted stock', 'Cleaned the dock']), mk(['Cleaned the dock', 'Packed boxes', 'Counted stock']), false, false, 0],
  ['a run-on split into three bullets', mk(['I load trucks and unloaded them and also i count the stock every week then I reported damaged boxs to the supervisor']), mk(['Loaded and unloaded trucks', 'Counted stock every week', 'Reported damaged boxes to the supervisor']), true, true, null],
  ['padding: one clear line split in two', mk(['Loaded and unloaded trucks']), mk(['Loaded trucks', 'Unloaded trucks']), true, false, 2],
  ['nothing changed', mk(BASE), mk(BASE), false, false, 0],
];
test('the proposed rule vs the current rule, case by case', () => {
  for (const [label, a, b, cur, prop, pts] of CASES) {
    const A = Core.clean(a); const B = Core.clean(b); const p = points(A, B);
    assert.equal(current(A, B), cur, `current rule: ${label}`);
    assert.equal(p.charge, prop, `proposed rule: ${label} (${p.total} points ${JSON.stringify(p.by)})`);
    if (pts !== null) assert.equal(p.total, pts, `points: ${label}`);
  }
});
test('the proposal differs from today in exactly one direction: collections of real corrections and removed repeats become chargeable; nothing becomes cheaper except padding', () => {
  const differs = CASES.filter(([, , , cur, prop]) => cur !== prop).map(([l]) => l);
  assert.deepEqual(differs, ['THREE typos fixed', 'SIX typos fixed', 'three vague words made specific', 'three repeated lines removed', 'padding: one clear line split in two']);
});
test('on the writing-quality personas: how each result would be charged now and under the proposal', () => {
  const table = {};
  for (const [name, c] of Object.entries(C)) { const A = Core.clean(c.before); const B = c.after ? Core.clean(c.after) : A; table[name] = { now: current(A, B), proposed: points(A, B).charge, points: points(A, B).total }; }
  assert.deepEqual(Object.fromEntries(Object.entries(table).map(([k, v]) => [k, [v.now, v.proposed]])), {
    firstPoor: [true, true], warehouse: [true, true], retail: [true, true], changer: [true, true], gap: [true, true], disorganized: [true, true], polished: [false, false], incomplete: [true, true],
    spellingOnly: [false, true] });                                                      // the one persona the owner's principle changes: six spelling fixes, no rewrite
  assert.equal(table.polished.points, 0); assert.ok(table.spellingOnly.points >= THRESHOLD);
});
test('the AI cannot manufacture points: they come only from differences against the customer\'s own words', () => {
  const A = Core.clean(mk(['Rang up purchases for customers', 'Counted the cash drawer at closing']));
  assert.equal(points(A, A).total, 0);
  const padded = Core.clean(mk(['Rang up purchases for customers', 'Counted the cash drawer at closing', 'Rang up purchases for customers', 'Counted the cash drawer at closing']));
  assert.ok(points(A, padded).total <= 2, 'duplicated lines are not corrections');
});
