// Accuracy of the factual guard in BOTH directions, on single-line edits of fictional text:
//   * an honest edit (spelling, tense, grammar, a plain word for a vague one) must be KEPT: a guard that withholds good edits leaves the customer
//     with their own mistakes and a polish that did nothing for them;
//   * an invented or inflated line must be WITHHELD.
// The honest corpus was written independently of the guard (a QA author's list of what a careful editor writes), not tuned to pass it.
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../../netlify/functions/_lib/integrity');
const Core = require('../../resume-core.js');

const K = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const blank = () => ({ contact: { email: 'x@example.com' }, certifications: [], awards: [], projects: [], volunteer: [], experience: [], education: [], summary: { tagline: '', bullets: [], skills: [] } });
const job = (title, company, bullets) => ({ ...blank(), name: 'Test Person', experience: [{ title, company, start: '2019', end: '2024', bullets }] });
const kept = (title, company, src, cand) => {
  const g = I.guardResume(Core.clean(job(title, company, src)), Core.clean(job(title, company, [cand, ...src.slice(1)])), { mode: 'polish', vocabulary: '' });
  return g.resume.experience[0].bullets.some((b) => K(b) === K(cand));
};

// [title, company, source bullets, edited first bullet]
const HONEST = [
  ['Warehouse Associate', 'Fictional Freight Co', ['Helped new workers learn how to pick and pack orders.'], 'Helped train new employees to pick and pack warehouse orders'],   // the owner's own example
  ['Cashier', 'Fictional Corner Store', ['i answer phone and take messages for the managers'], 'Answered phones and took messages for the managers'],
  ['Dishwasher', 'Fictional Diner', ['wash dishes and clean tables, sometimes help cook'], 'Washed dishes, cleaned tables, and sometimes helped the cook'],
  ['Stock Clerk', 'Fictional Grocery', ['stock shelves and help customers find stuff'], 'Stocked shelves and helped customers find items'],
  ['Cashier', 'Fictional Grocery', ['worked the cash register, bag groceries'], 'Operated the cash register and bagged groceries'],
  ['Caregiver', 'Family', ['take care of my 3 younger brothers after school'], 'Cared for three younger brothers after school'],
  ['Sandwich Maker', 'Fictional Deli', ['make sandwiches and talk to customers'], 'Prepared sandwiches and spoke with customers'],
  ['Driver', 'Fictional Parcel Co', ['drive truck to deliver packages to houses'], 'Drove a truck to deliver packages to homes'],
  ['Office Clerk', 'Fictional Insurance', ['did data entry in excel for the office'], 'Entered data in Excel for the office'],
  ['Babysitter', 'Neighborhood', ['babysat for neighbors kids'], 'Babysat neighbors\' children'],
  ['Swim Aide', 'Fictional YMCA', ['taught kids to swim at the YMCA'], 'Taught children to swim at the YMCA'],
  ['Tutor', 'Fictional Library', ['help kids with their homework after school'], 'Helped children with homework after school'],
  ['Mover', 'Fictional Moving Co', ['load furniture in the truck and unload at the new house'], 'Loaded furniture into the truck and unloaded it at the new home'],
  ['Cashier', 'Fictional Pharmacy', ['counted money at end of shift'], 'Counted the money at the end of each shift'],
  ['Bagger', 'Fictional Grocery', ['bag groceries and carry them to cars for people'], 'Bagged groceries and carried them to cars for people'],
  ['Receptionist', 'Fictional Clinic', ['greet people, answer the phone, make appointments'], 'Greeted people, answered the phone, and made appointments'],
  ['Landscaper', 'Fictional Lawn Co', ['plant flowers and water them, rake leaves'], 'Planted and watered flowers and raked leaves'],
  ['Janitor', 'Fictional School', ['clean classrooms and empty trash'], 'Cleaned classrooms and emptied the trash'],
  ['Construction Helper', 'Fictional Builders', ['carry materials and clean the work site'], 'Carried materials and cleaned the work site'],
  ['Retail Associate', 'Fictional Clothing Store', ['fold clothes, put clothes back on racks, help people in fitting rooms'], 'Folded clothes, put clothes back on racks, and helped people in fitting rooms'],
  ['Assistant', 'Fictional Vet Clinic', ['feed the animals and clean cages'], 'Fed the animals and cleaned cages'],
  ['Server', 'Fictional Cafe', ['take orders and bring food to tables'], 'Took orders and brought food to tables']
];
const TENSE = [   // present or base form -> past: the most common correction on a past job
  ['close the store at night', 'Closed the store at night'], ['carry boxes to the truck', 'Carried boxes to the truck'], ['apply price labels to items', 'Applied price labels to items'],
  ['process payments and refunds', 'Processed payments and refunds'], ['supply the stockroom with boxes', 'Supplied the stockroom with boxes'], ['copy documents for managers', 'Copied documents for managers'],
  ['tidy the break room', 'Tidied the break room'], ['empty the trash', 'Emptied the trash'], ['reply to customer emails', 'Replied to customer emails'], ['verify orders before shipping', 'Verified orders before shipping'],
  ['I count inventories each week', 'Counted inventories each week'], ['use the cash register', 'Used the cash register'], ['move heavy boxes', 'Moved heavy boxes'], ['prepare food orders', 'Prepared food orders'],
  ['receive shipments', 'Received shipments'], ['serve customers', 'Served customers'], ['handle customer complaints', 'Handled customer complaints'], ['stock shelves', 'Stocked shelves'],
  ['study the price list', 'Studied the price list'], ['deliver orders to families', 'Delivered orders to families'], ['try new recipes', 'Tried new recipes']
];
const SPELLING = [   // several mistakes put right in one line, and skills
  ['ring up custmers at the registar', 'Ring up customers at the register'], ['helpd custumers find there stuff', 'Helped customers find their things'], ['i wuz in charge of the registar', 'I was at the register'],
  ['count the cash drawr and clenup', 'Count the cash drawer and clean up'], ['stock shelfs and clean the aisels', 'Stock shelves and clean the aisles'], ['Rang up purchases for custmers', 'Rang up purchases for customers']
];
// Invented or inflated: every one of these must be withheld.
const INVENTED = [
  ['Warehouse Associate', 'Fictional Freight Co', ['Helped new workers learn how to pick and pack orders.'], 'Led comprehensive workforce development initiatives to optimize fulfillment operations'],   // the owner's own "not acceptable" example
  ['Warehouse Associate', 'Fictional Freight Co', ['Helped new workers learn how to pick and pack orders.'], 'Trained and supervised new employees'],
  ['Cashier', 'Fictional Corner Store', ['i answer phone and take messages for the managers'], 'Managed all phone communication for the management team'],
  ['Dishwasher', 'Fictional Diner', ['wash dishes and clean tables, sometimes help cook'], 'Washed dishes and cleaned tables in a fast-paced restaurant environment'],
  ['Stock Clerk', 'Fictional Grocery', ['stock shelves and help customers find stuff'], 'Stocked shelves and helped over 100 customers daily'],
  ['Cashier', 'Fictional Grocery', ['worked the cash register, bag groceries'], 'Operated the cash register with 100% accuracy'],
  ['Yard Worker', 'Self-employed', ['cut grass, trim hedges for neighbors'], 'Founded and operated a landscaping business serving neighbors'],
  ['Caregiver', 'Family', ['take care of my 3 younger brothers after school'], 'Supervised three younger siblings, ensuring safety and homework completion'],
  ['Sandwich Maker', 'Fictional Deli', ['make sandwiches and talk to customers'], 'Prepared sandwiches and delivered excellent customer service'],
  ['Driver', 'Fictional Parcel Co', ['drive truck to deliver packages to houses'], 'Drove a truck to deliver packages to homes across the region, maintaining a perfect safety record'],
  ['Office Clerk', 'Fictional Insurance', ['did data entry in excel for the office'], 'Entered data in Excel and created reports for management'],
  ['Babysitter', 'Neighborhood', ['babysat for neighbors kids'], 'Babysat neighbors\' children and taught them reading skills'],
  ['Swim Aide', 'Fictional YMCA', ['taught kids to swim at the YMCA'], 'Taught children to swim and earned lifeguard certification'],
  ['Cashier', 'Fictional Pharmacy', ['counted money at end of shift'], 'Counted money at the end of every shift and prepared bank deposits'],
  ['Server', 'Fictional Cafe', ['take orders and bring food to tables'], 'Took orders and brought food to tables for up to 40 guests'],
  ['Barista', 'Fictional Cafe', ['make coffee and keep the counter clean'], 'Made coffee and trained new baristas'],
  ['Janitor', 'Fictional School', ['clean classrooms and empty trash'], 'Cleaned classrooms and emptied trash, improving school hygiene'],
  ['Cook', 'Fictional Diner', ['cook breakfast and lunch orders'], 'Cooked breakfast and lunch orders and planned the menu'],
  ['Bagger', 'Fictional Grocery', ['bag groceries and carry them to cars for people'], 'Bagged groceries and organized the carry-out program'],
  ['Receptionist', 'Fictional Clinic', ['greet people, answer the phone, make appointments'], 'Greeted patients and coordinated appointments for doctors'],
  ['Landscaper', 'Fictional Lawn Co', ['plant flowers and water them, rake leaves'], 'Planted flowers and designed garden layouts'],
  ['Tutor', 'Fictional Library', ['help kids with their homework after school'], 'Tutored students in math and science'],
  ['Delivery Driver', 'Fictional Pizza', ['deliver pizzas on time and handle cash'], 'Delivered pizzas on time with a 98% on-time rate'],
  ['Assistant', 'Fictional Vet Clinic', ['feed the animals and clean cages'], 'Fed animals and assisted veterinarians during surgery'],
  ['Construction Helper', 'Fictional Builders', ['carry materials and clean the work site'], 'Carried materials and operated heavy equipment'],
  ['Team Member', 'Fictional Fast Food', ['take orders, make food, clean up'], 'Took orders, made food, and cleaned up for the busy lunch rush'],
  ['Intern', 'Fictional Marketing Firm', ['made copies and filed papers'], 'Supported marketing campaigns by preparing materials'],
  ['Cashier', 'Fictional Store', ['ring up custmers at the registar'], 'Rang up customers at the register for over 200 customers a day'],
  ['Clerk', 'Fictional Store', ['carry boxes to the truck'], 'Carried boxes to the truck and led the loading crew'],
  ['Clerk', 'Fictional Store', ['process payments and refunds'], 'Processed payments and refunds, reducing errors by half'],
  ['Clerk', 'Fictional Store', ['i helped with the garden'], 'Organized the community garden for families']
];
// Honest but deliberately withheld: it names WHO was served or WHERE, which the customer did not say. The guard keeps the customer's own words.
const STRICT_BY_DESIGN = [
  ['Clerk', 'Fictional Hardware', ['help people find tools and screws'], 'Helped customers find tools and screws'],
  ['Hostess', 'Fictional Restaurant', ['seat people and answer phone'], 'Seated guests and answered the phone'],
  ['Lifeguard', 'Fictional Pool', ['watch the pool and help people who need it'], 'Watched the pool and helped swimmers who needed it'],
  ['Delivery Driver', 'Fictional Pizza', ['deliver pizzas on time and handle cash'], 'Delivered pizzas and handled cash payments']
];

test('honest edits are kept: the owner\'s own example, plain rewording, and the replacement of vague words', () => {
  for (const [t, c, src, cand] of HONEST) assert.equal(kept(t, c, src, cand), true, `${src[0]}  ->  ${cand}`);
});
test('the most common correction, present tense to past tense, is kept for every verb form (carry/carried, apply/applied, process/processed, close/closed, ...)', () => {
  for (const [a, b] of TENSE) assert.equal(kept('Clerk', 'Fictional Store', [a], b), true, `${a}  ->  ${b}`);
});
test('several misspellings corrected in one line are kept (a corrected word is the customer\'s own word)', () => {
  for (const [a, b] of SPELLING) assert.equal(kept('Clerk', 'Fictional Store', [a], b), true, `${a}  ->  ${b}`);
});
test('invented or inflated lines are withheld: leadership, numbers, results, setting, praise, ownership, credentials, new duties', () => {
  for (const [t, c, src, cand] of INVENTED) assert.equal(kept(t, c, src, cand), false, `${src[0]}  ->  ${cand}`);
});
test('known strictness: naming who was served or where, when the customer did not, is withheld even though it is honest (the customer keeps their own words)', () => {
  for (const [t, c, src, cand] of STRICT_BY_DESIGN) assert.equal(kept(t, c, src, cand), false, `${src[0]}  ->  ${cand}`);
});
test('"helped train" is accepted only when the entry speaks of learning or new people; "taught" only when the entry speaks of showing or teaching', () => {
  assert.equal(kept('Clerk', 'Fictional Store', ['Helped new workers learn the register'], 'Helped train new employees on the register'), true);
  assert.equal(kept('Clerk', 'Fictional Store', ['worked the register'], 'Helped train new employees on the register'), false, 'nothing in the entry says anyone learned');
  assert.equal(kept('Clerk', 'Fictional Store', ['Helped new workers learn the register'], 'Trained new employees on the register'), false, 'helped must not become trained');
  assert.equal(kept('Clerk', 'Fictional Store', ['showed new people how to use the pallet jack'], 'Taught new people to use the pallet jack'), true);
  assert.equal(kept('Babysitter', 'Neighborhood', ['babysat for neighbors kids'], 'Babysat neighbors\' children and taught them reading'), false);
});

// ── skills ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const skillRun = (skills, cand, tagline = '', bullets = ['sell things']) => {
  const src = { ...blank(), name: 'T', summary: { tagline, bullets: [], skills }, experience: [{ title: 'Clerk', company: 'Fictional Store', start: '2020', end: '2024', bullets }] };
  const out = JSON.parse(JSON.stringify(src)); out.summary.skills = cand;
  return I.guardResume(Core.clean(src), Core.clean(out), { mode: 'polish', vocabulary: tagline }).resume.summary.skills;
};
test('skills: a corrected spelling or tidier phrasing of the customer\'s own skill is kept', () => {
  assert.deepEqual(skillRun(['costumer service', 'paperwerk', 'gps'], ['Customer service', 'Paperwork', 'GPS']), ['Customer service', 'Paperwork', 'GPS']);
  assert.deepEqual(skillRun(['work hard', 'learn fast'], ['Hard worker', 'Fast learner']), ['Hard worker', 'Fast learner']);
  assert.deepEqual(skillRun(['cash handeling'], ['Cash handling']), ['Cash handling']);
});
test('skills: the goal the customer typed never supports a skill (a career changer is not credited with the new field)', () => {
  assert.deepEqual(skillRun(['driving', 'paperwork'], ['Driving', 'Paperwork', 'Dispatch'], 'truck driver who wants to move into dispatch or office work').map((x) => x.toLowerCase()), ['driving', 'paperwork'], 'Dispatch is not added');
  assert.equal(skillRun(['driving'], ['Driving', 'Dispatch'], 'move into dispatch').includes('Dispatch'), false);
  assert.equal(skillRun(['driving'], ['Driving', 'Retail sales'], 'looking for retail sales work').includes('Retail sales'), false);
});
test('skills: a skill the customer never listed or described stays out, praise included', () => {
  assert.equal(skillRun(['teamwork'], ['Teamwork', 'Leadership']).includes('Leadership'), false);
  assert.equal(skillRun(['teamwork'], ['Teamwork', 'Excellent communication']).includes('Excellent communication'), false);
  assert.equal(skillRun(['teamwork'], ['Teamwork', 'Salesforce']).includes('Salesforce'), false);
});

// ── the stemmer: every word form an honest editor may change ──────────────────────────────────────────────────────────────
test('stem: tense, plural and -ing forms of the same word meet, including -y/-ied/-ies and double letters', () => {
  const PAIRS = ['carry carried carries carrying', 'study studied studies', 'apply applied applies', 'copy copied copies', 'supply supplied supplies', 'try tried tries', 'reply replied', 'verify verified',
    'identify identified', 'tidy tidied', 'empty emptied', 'family families', 'party parties', 'baby babies', 'city cities', 'inventory inventories', 'delivery deliveries', 'close closed closing closes', 'process processed processing processes',
    'load loaded loading loads', 'stop stopped', 'plan planned', 'ship shipped', 'order orders ordered ordering', 'box boxes', 'dish dishes', 'watch watches', 'shelf shelves', 'child children', 'person people', 'babysit babysat', 'use used using', 'move moved moving'];
  for (const row of PAIRS) { const w = row.split(' '); const s0 = I.stem(w[0]); for (const x of w.slice(1)) assert.ok(s0 === I.stem(x) || I.known(new Set([s0]), I.stem(x)) || I.known(new Set([I.stem(x)]), s0), `${w[0]} / ${x}: ${s0} vs ${I.stem(x)}`); }
});
test('stem: it does not over-reach: words that are different things stay different', () => {
  const DIFFERENT = [['lead', 'load'], ['manager', 'man'], ['cash', 'catch'], ['stock', 'stack'], ['pack', 'park'], ['dish', 'disk'], ['bus', 'bug'], ['class', 'clam']];
  for (const [a, b] of DIFFERENT) assert.notEqual(I.stem(a), I.stem(b), `${a} / ${b}`);
});

// ── a line moved from one entry into another (found by mutation testing: nothing failed when this check was switched off) ─────────────────
test('a line copied from another entry is withheld even when every one of its words already appears in the entry it was copied into', () => {
  const src = { ...blank(), name: 'T', experience: [
    { title: 'Stock Clerk', company: 'Fictional Grocery', start: '2018', end: '2020', bullets: ['Counted stock on Fridays', 'Counted the money at night'] },
    { title: 'Cashier', company: 'Fictional Market', start: '2020', end: '2024', bullets: ['Counted stock every week and the money in the drawer', 'Rang up customers'] }] };
  const out = JSON.parse(JSON.stringify(src)); out.experience[1].bullets[1] = 'Counted stock on Fridays';                   // job 1's line, every word is also in job 2
  const g = I.guardResume(Core.clean(src), Core.clean(out), { mode: 'polish', vocabulary: '' });
  assert.equal(g.resume.experience[1].bullets.includes('Counted stock on Fridays'), false, 'the borrowed line must not appear under the other job');
  assert.ok(g.withheld.some((w) => w.reasons.some((r) => /different entry|another entry|different part/.test(r))), JSON.stringify(g.withheld));
});

// ── found by the Round 3 evaluation of complete resumes ─────────────────────────────────────────────────────────────────────────
test('skills: when ONE skill is withheld, the corrected versions of the others are not duplicated beside the originals, and no charge comes from an added skill', () => {
  const src = { ...blank(), name: 'T', summary: { tagline: '', bullets: [], skills: ['costumer service', 'paperwerk'] }, experience: [{ title: 'Clerk', company: 'Fictional Store', start: '2020', end: '2024', bullets: ['sell things'] }] };
  const out = JSON.parse(JSON.stringify(src)); out.summary.skills = ['Customer service', 'Paperwork', 'Teamwork'];
  const g = I.guardResume(Core.clean(src), Core.clean(out), { mode: 'polish', vocabulary: '' });
  assert.deepEqual(g.resume.summary.skills, ['Customer service', 'Paperwork'], 'no "costumer service" beside "Customer service", and no unlisted Teamwork');
  const pts = require('../../netlify/functions/_lib/scoring').score(Core.clean(src), g.resume);
  assert.equal(pts.by.added, 0, 'a skill the AI added is never an improvement the customer pays for');
});
test('the headline: one new quality word (creative, experienced, bilingual, compassionate) is withheld; a corrected spelling or a restated goal is kept', () => {
  const run = (tag, cand) => {
    const src = { ...blank(), name: 'T', summary: { tagline: tag, bullets: [], skills: ['cash'] }, experience: [{ title: 'Cashier', company: 'Fictional Market', start: '2020', end: '2024', bullets: ['ring up customers'] }] };
    const out = JSON.parse(JSON.stringify(src)); out.summary.tagline = cand;
    return I.guardResume(Core.clean(src), Core.clean(out), { mode: 'polish', vocabulary: 'retail cashier' }).resume.summary.tagline === cand;
  };
  for (const bad of ['Creative cashier seeking a retail job', 'Experienced cashier seeking a retail job', 'Bilingual cashier seeking a retail job', 'Cashier with Spanish and English fluency']) assert.equal(run('i want a cashier job', bad), false, bad);
  assert.equal(run('student who loves animals', 'Compassionate student who loves animals'), false);
  for (const [a, b] of [['i want a cashier job', 'I want a cashier job.'], ['looking for a job in a resturant or store', 'Looking for a job in a restaurant or store'], ['cashier with experiance', 'Cashier with experience'], ['i want a cashier job', 'Cashier seeking a retail job']]) assert.equal(run(a, b), true, b);
});

// ── duties are never lost: found when the independent corpus was run through the guard ────────────────────────────────────────────
test('a unique duty the AI deletes is put back even when one of its words appears in another line ("cleaned tables" is not "served food to the tables")', () => {
  const src = { ...blank(), name: 'T', experience: [{ title: 'Server', company: 'Fictional Diner', start: '2019', end: '2024', bullets: ['served food to the tables', 'cleaned tables', 'wash dishes sometimes', 'handled money'] }] };
  const out = JSON.parse(JSON.stringify(src)); out.experience[0].bullets = ['Served food to the tables', 'Handled money'];                      // two real duties dropped
  const g = I.guardResume(Core.clean(src), Core.clean(out), { mode: 'polish', vocabulary: '' });
  const keys = g.resume.experience[0].bullets.map(K);
  assert.ok(keys.some((k) => /clean/.test(k) && /table/.test(k)), 'cleaning tables is still there'); assert.ok(keys.some((k) => /dish/.test(k)), 'washing dishes is still there');
});
test('a verb swapped for another is not a lost duty (no duplicate of the original is put back beside the reworded line)', () => {
  const src = { ...blank(), name: 'T', experience: [{ title: 'Clerk', company: 'Fictional Store', start: '2019', end: '2024', bullets: ['Filed paperwork each day', 'Did the register', 'Assisted customers at the register'] }] };
  const out = JSON.parse(JSON.stringify(src)); out.experience[0].bullets = ['Handled paperwork each day', 'Operated the register', 'Handled customers at the register'];
  const b = I.guardResume(Core.clean(src), Core.clean(out), { mode: 'polish', vocabulary: '' }).resume.experience[0].bullets;
  assert.equal(b.length, 3, JSON.stringify(b));
});

// A withheld line keeps the customer's own words, but not their misspellings: the spelling part of the AI's line is theirs and safe to apply.
test('withholding a reach still applies the customer\'s spelling corrections (salvage)', () => {
  const out = I.guardResume(Core.clean(job('Cashier', 'Fictional Grocery', ['stock the shelvs and help custmers find items'])),
    Core.clean(job('Cashier', 'Fictional Grocery', ['Stocked the shelves and led a team of 12 to help customers find items'])), { mode: 'polish', vocabulary: '' });
  const line = out.resume.experience[0].bullets[0];
  assert.equal(out.withheld.length, 1);
  assert.match(line, /shelves/); assert.match(line, /customers/); assert.doesNotMatch(line, /team|12|led/);
});

// Found by a second, independent holdout corpus (2026-10-23): rules, not cases.
test('"the manager" is someone else: it never makes "Managed ..." the customer\'s own claim, but it is not a claim itself either', () => {
  const src = ['stocked shelves', 'worked in the freezer section', 'did stuff for the manager'];
  const run = (cand) => I.guardResume(Core.clean(job('Stock Person', 'Fictional Foods', src)), Core.clean(job('Stock Person', 'Fictional Foods', [src[0], cand, src[2]])), { mode: 'polish', vocabulary: '' }).resume.experience[0].bullets[1];
  assert.equal(run('Managed the freezer section.'), 'Worked in the freezer section');                // withheld: the customer worked there
  assert.equal(run('Supervised the freezer section'), 'Worked in the freezer section');
  assert.ok(kept('Stock Person', 'Fictional Foods', ['I tell my supervisor if something is broken in the room'], 'Tell my supervisor if something is broken in the room'));
  assert.equal(kept('Cashier', 'Fictional Store', ['worked the ledger and the register'], 'Led the register'), false, '"led" is not found inside "ledger"');
});
test('joined words, everyday equivalents and spelling fixes of a duty word are honest edits', () => {
  assert.ok(kept('Kennel Aide', 'Fictional Pets', ['greeted owners at drop off and pick up'], 'Greeted owners at drop-off and pickup'));
  assert.ok(kept('Janitor', 'Fictional School', ['I keep the floor clean and take out the garbage'], 'I keep the floor clean and take out the trash'));
  assert.ok(kept('Mechanic Helper', 'Fictional Garage', ['kept the tools orgenized and the shop clean'], 'Kept the tools organized and the shop clean'));
  assert.ok(kept('Cashier', 'Fictional Grocery', ['stayed calm when customers were mad'], 'Stayed calm when customers were angry'));
});

