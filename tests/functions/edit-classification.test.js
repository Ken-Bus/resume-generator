// What is worth a generation? A table of line edits and how they are classified, fictional wording only. Pure functions, no database.
// cosmetic = capitals / punctuation / spacing;  minor = one word added, removed or swapped in one place, or only filler words changed;
// rewrite = everything else. Only a rewrite (or a new line) is charged. The rule looks at the SHAPE of the edit, never at line length.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyEdit, assessChange } = require('../../netlify/functions/_lib/integrity');

const CASES = [
  // [before, after, kind, why]
  ['Helped organize food for pickup', 'Helped organize donated food for pickup', 'minor', 'one word added (the live-test case)'],
  ['Helped customers', 'Assisted customers', 'minor', 'synonym swap'],
  ['Rang up items', 'Rang up items and more', 'minor', 'filler only'],
  ['Rang up items', 'Rang up items also', 'minor', 'filler only'],
  ['handle money', 'handled money', 'minor', 'one-word grammar fix'],
  ['very very good at sorting', 'very good at sorting', 'minor', 'one repeated word removed'],
  ['Sorted cans in the back room', 'Sorted cans in a back room', 'minor', 'filler swapped'],
  ['Packed boxes on Saturdays', 'Packed boxes on Saturdays.', 'cosmetic', 'full stop'],
  ['packed boxes on saturdays', 'Packed Boxes On Saturdays', 'cosmetic', 'capitals'],
  ['Packed   boxes', 'Packed boxes', 'cosmetic', 'spacing'],
  ['i answer phone and recieve payments and stuff', 'I answered phones and received payments', 'rewrite', 'several grammar and wording fixes'],
  ['Did stuff with the oven and the counter and also the oven', 'Did the oven and the counter', 'rewrite', 'repetition and filler removed in two places'],
  ['Worked on the register', 'Operated the register', 'rewrite', 'weak opener replaced by a clear verb (two words become one)'],
  ['Asked classmates to donate canned food', 'Asked classmates to donate canned food for a local pantry', 'rewrite', 'a new detail clause'],
  ['Greeted families as they arrived', 'Greeted arriving families', 'rewrite', 'tightened'],
  ['Counted the drawer at closing', 'At closing, counted the drawer', 'rewrite', 'restructured'],
  ['Answered phones', 'Answered customer phones daily', 'rewrite', 'two content words added'],
  ['Sorted and counted cans', 'Counted and sorted cans', 'rewrite', 'two separate edits'],
];
test('classifyEdit: each kind of edit is judged the same way every time', () => {
  for (const [x, y, kind, why] of CASES) assert.equal(classifyEdit(x, y), kind, `${why}: ${x} -> ${y}`);
});
test('the rule does not depend on how long the line is: the same edit shape gets the same answer', () => {
  const pad = (t, n) => `${'Ran the weekend inventory count with the shipping team and then reported the results to the manager, ' .repeat(n)}${t}`;
  for (const n of [0, 1, 4]) {
    assert.equal(classifyEdit(pad('Helped organize food for pickup', n), pad('Helped organize donated food for pickup', n)), 'minor');
    assert.equal(classifyEdit(pad('Counted the drawer at closing', n), pad('At closing, counted the drawer', n)), 'rewrite');
  }
});
test('assessChange: lines are matched by content, so deleting a duplicate or re-ordering does not look like a rewrite', () => {
  const mk = (bullets, skills = ['Teamwork', 'Scheduling']) => ({ summary: { tagline: '', bullets: [], skills }, experience: [{ title: 'Baker', company: 'Fictional Bakery', summary: '', bullets }], volunteer: [], projects: [] });
  const base = mk(['various duties', 'various duties', 'Cleaned the oven']);
  assert.deepEqual(assessChange(base, mk(['various duties', 'Cleaned the oven'])), { reworded: 0, minor: 0, cosmetic: 0, unchanged: 4, dropped: 1 });
  assert.deepEqual(assessChange(base, mk(['Cleaned the oven', 'various duties', 'various duties'])), { reworded: 0, minor: 0, cosmetic: 0, unchanged: 5, dropped: 0 }, 're-ordered lines are unchanged lines');
  assert.deepEqual(assessChange(mk(['a b c', 'x y z'], ['Teamwork', 'Scheduling']), mk(['a b c', 'x y z'], ['Scheduling', 'Teamwork'])).reworded, 0);
  const one = assessChange(base, mk(['various duties', 'various duties', 'Cleaned the oven thoroughly']));
  assert.deepEqual([one.reworded, one.minor], [0, 1]);
  const real = assessChange(base, mk(['various duties', 'various duties', 'The oven: cleaned it each night']));
  assert.ok(real.reworded >= 1);
  assert.equal(assessChange(base, mk(['various duties', 'various duties', 'Cleaned the oven', 'Opened the shop early'])).reworded, 1, 'a genuinely new line counts');
});
test('a result with many one-word touch-ups is still not charged (the rule is about the kind of edit, not how many)', () => {
  const mk = (b) => ({ summary: { tagline: '', bullets: [], skills: [] }, experience: [{ title: 'Cashier', company: 'Fictional Market', bullets: b }], volunteer: [], projects: [] });
  const a = assessChange(mk(['Rang up items', 'Counted the drawer', 'Helped customers', 'Stocked shelves']), mk(['Rang up all items', 'Counted the cash drawer', 'Assisted customers', 'Stocked the shelves']));
  assert.equal(a.reworded, 0); assert.equal(a.minor, 4);
});
