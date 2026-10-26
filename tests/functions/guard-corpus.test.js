// A fixed corpus of plausible AI lines, judged by the entry-scoped guard: subtle inventions (a single new fact in plain words) must be
// withheld, honest rewrites (restructuring, spelling and grammar fixes, neutral verb swaps, details from the SAME entry) must be kept.
// Known limits are listed in KNOWN_* and asserted as they are, so a change in either direction is noticed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { guardResume } = require('../../netlify/functions/_lib/integrity');
const Core = require('../../resume-core.js');
const { P, clone } = require('./personas');

// kept = by presence: the guard may also remove the customer's own exact repeats, which moves the index
const run = (persona, [k, i, j], line) => { const src = Core.clean(P[persona]); const out = clone(src); out[k][i].bullets[j] = line; const g = guardResume(src, out, { mode: 'polish', vocabulary: 'customer service' }); return { kept: g.resume[k][i].bullets.includes(line), g }; };

const INVENTED = [   // [persona, where, line, what it invents]
  ['experienced', ['experience', 1, 0], 'Loaded and unloaded trucks quickly and safely', 'quality claim'],
  ['experienced', ['experience', 1, 1], 'Collaborated with the shipping team to meet deadlines', 'deadlines'],
  ['experienced', ['experience', 1, 2], 'Counted stock each week to prevent shortages', 'implied result'],
  ['experienced', ['experience', 0, 2], 'Led the dock team in loading trucks', 'leadership'],
  ['experienced', ['experience', 2, 1], 'Helped customers find items in a busy store', 'setting'],
  ['experienced', ['experience', 2, 3], 'Handled customer returns and refunds', 'refunds'],
  ['experienced', ['experience', 0, 1], 'Checked orders for accuracy before shipping', 'a process step from another job'],
  ['firstDetailed', ['projects', 0, 0], 'Asked classmates to donate canned food for the school pantry', 'beneficiary from another entry'],
  ['firstDetailed', ['projects', 0, 1], 'Sorted and counted donated items by type', 'a method'],
  ['firstDetailed', ['projects', 0, 2], 'Helped organize food pickup for local residents', 'beneficiary'],
  ['firstDetailed', ['volunteer', 0, 0], 'Packed grocery boxes every Saturday for families in need', 'who benefited'],
  ['firstDetailed', ['projects', 1, 0], 'Tested three filter designs and chose the best one', 'an outcome'],
  ['changer', ['experience', 0, 0], 'Answered customer questions by phone and in person with a friendly attitude', 'personality claim'],
  ['changer', ['experience', 0, 1], 'Kept accurate records of shipments in the company database', 'a system'],
  ['changer', ['experience', 0, 2], 'Followed safety rules on the floor and reported hazards', 'a duty'],
  ['returning', ['volunteer', 0, 1], 'Collected money at school events and deposited it at the bank', 'a duty'],
  ['returning', ['volunteer', 0, 0], 'Managed the PTA records', 'responsibility inflation'],
  ['multi', ['experience', 0, 1], 'Counted the drawer at closing and reported discrepancies', 'a duty'],
  ['multi', ['experience', 1, 1], 'Helped unload deliveries and check them against invoices', 'a duty'],
  ['polished', ['experience', 0, 2], 'Balanced the drawer and prepared the nightly deposit for the manager', 'a person'],
  ['poor', ['experience', 0, 1], 'Rang up items for customers during busy periods', 'setting'],
  ['poor', ['experience', 0, 2], 'Handled cash and made change accurately', 'quality claim']
];
const HONEST = [
  ['poor', ['experience', 0, 0], 'I answered phones and received payments'],                    // spelling + grammar
  ['poor', ['experience', 0, 2], 'Handled money'],
  ['firstDetailed', ['volunteer', 0, 0], 'Packed grocery boxes every Saturday'],
  ['firstDetailed', ['volunteer', 0, 1], 'Welcomed families as they arrived'],
  ['firstDetailed', ['projects', 0, 0], 'Asked classmates to donate canned food for the food drive'],   // a detail from the same entry's name
  ['experienced', ['experience', 2, 0], 'Restocked shelves'],
  ['experienced', ['experience', 1, 3], 'Reported boxes that were damaged'],
  ['experienced', ['experience', 0, 0], 'Taught new people to use the pallet jack'],
  ['experienced', ['experience', 1, 0], 'Loaded and unloaded trucks for the shipping team'],
  ['changer', ['experience', 0, 0], 'Answered customer questions in person and by phone'],
  ['changer', ['experience', 0, 1], 'Kept accurate shipment records'],
  ['changer', ['experience', 0, 2], 'Followed safety rules while working on the floor'],
  ['returning', ['experience', 0, 1], 'Filed paperwork daily'],
  ['returning', ['volunteer', 0, 1], 'Collected money during school events'],
  ['multi', ['experience', 0, 0], 'Helped customers at the register'],
  ['multi', ['experience', 1, 1], 'Helped to unload deliveries'],
  ['multi', ['projects', 0, 0], 'Arranged the products by color'],
  ['ambiguous', ['experience', 0, 2], 'Worked the oven and the counter']
];
// Known limits, asserted so they are visible. Adjectives/adverbs the customer did not write are withheld even when harmless;
// words that already appear in the same entry ("safe", "agents") are the customer's own and pass.
const KNOWN_HARMLESS_BUT_WITHHELD = [['firstDetailed', ['projects', 1, 0], 'Tested three different filter designs'], ['polished', ['experience', 0, 0], 'Processed roughly 200 transactions each shift with accurate cash drawers']];
const KNOWN_PASS_BECAUSE_IN_ENTRY = [['experienced', ['experience', 0, 3], 'Kept the dock safe and clean'], ['returning', ['experience', 0, 0], 'Answered the phones and greeted visitors for the insurance agents']];

test('subtle single-fact inventions are withheld', () => { for (const [p, at, line, why] of INVENTED) assert.equal(run(p, at, line).kept, false, `${why}: ${line}`); });
test('honest rewrites (restructuring, spelling and grammar, neutral verbs, same-entry detail) are kept', () => { for (const [p, at, line] of HONEST) assert.equal(run(p, at, line).kept, true, line); });
test('known limits behave exactly as documented', () => {
  for (const [p, at, line] of KNOWN_HARMLESS_BUT_WITHHELD) assert.equal(run(p, at, line).kept, false, line);
  for (const [p, at, line] of KNOWN_PASS_BECAUSE_IN_ENTRY) assert.equal(run(p, at, line).kept, true, line);
});
