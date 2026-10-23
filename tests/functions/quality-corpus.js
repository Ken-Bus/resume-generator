// Realistic fictional resumes that need real editing, each with the "ideal" faithful result a good editor would produce from ONLY what the
// person wrote: spelling, grammar and tense fixed, run-ons split, repetition removed, weak openers made specific, information organised.
// Nobody here is real. `after` is what a good AI should return; `lineCount` documents how many lines it changes.
const base = (o) => ({ contact: { email: `${o.name.split(' ')[0].toLowerCase()}@example.com`, location: 'Dayton, OH' }, certifications: [], awards: [], projects: [], volunteer: [], experience: [], education: [], ...o });
const C = {};

C.firstPoor = {
  label: 'first-time applicant, many spelling and grammar errors',
  before: base({ name: 'Alex Moreno', summary: { tagline: 'looking for a job in a resturant or store', bullets: [], skills: ['working with peoples', 'on time'] },
    education: [{ degree: 'High school diploma', school: 'Lakeview High School', date: '2027' }],
    projects: [{ name: 'yearbook club', description: 'i helped make the school yearbook', bullets: ['took pictures at the games and then i put them in the yearbook', 'wrote captions for the pictures', 'help with the layout of the pages and also i did layout'] }],
    volunteer: [{ title: 'Helper', organization: 'Fictional Church Kitchen', bullets: ['I serve food on sundays', 'cleaning tables and wash dishes'] }] }),
  after: base({ name: 'Alex Moreno', summary: { tagline: 'Looking for a job in a restaurant or store', bullets: [], skills: ['Working with people', 'On time'] },
    education: [{ degree: 'High school diploma', school: 'Lakeview High School', date: '2027' }],
    projects: [{ name: 'yearbook club', description: 'Helped make the school yearbook', bullets: ['Took pictures at the games and put them in the yearbook', 'Wrote captions for the pictures', 'Helped with the layout of the pages'] }],
    volunteer: [{ title: 'Helper', organization: 'Fictional Church Kitchen', bullets: ['Served food on Sundays', 'Cleaned tables and washed dishes'] }] })
};

C.warehouse = {
  label: '15 years in a warehouse, run-ons and inconsistent tense',
  before: base({ name: 'Marcus Webb', summary: { tagline: 'warehouse worker', bullets: [], skills: ['forklift', 'pallet jack', 'counting stock'] },
    experience: [{ title: 'Warehouse Associate', company: 'Fictional Freight Co', location: 'Dayton, OH', start: '2011', end: 'Present', summary: '',
      bullets: ['I load trucks and unloaded them and also i count the stock every week then I reported damaged boxs to the supervisor',
        'drive forklift and pallet jack', 'train new peoples to use the pallet jack', 'Loading trucks', 'keep the dock clean']}],
    education: [{ degree: 'High School Diploma', school: 'Oakwood High', date: '2009' }], certifications: [{ name: 'Forklift Safety Course', org: 'Fictional Safety Council', date: '2014' }] }),
  after: base({ name: 'Marcus Webb', summary: { tagline: 'Warehouse worker', bullets: [], skills: ['Forklift', 'Pallet jack', 'Counting stock'] },
    experience: [{ title: 'Warehouse Associate', company: 'Fictional Freight Co', location: 'Dayton, OH', start: '2011', end: 'Present', summary: '',
      bullets: ['Loaded and unloaded trucks', 'Counted stock every week', 'Reported damaged boxes to the supervisor', 'Drove a forklift and a pallet jack', 'Trained new people to use the pallet jack', 'Kept the dock clean'] }],
    education: [{ degree: 'High School Diploma', school: 'Oakwood High', date: '2009' }], certifications: [{ name: 'Forklift Safety Course', org: 'Fictional Safety Council', date: '2014' }] })
};

C.retail = {
  label: 'retail worker, weak openers and repetition',
  before: base({ name: 'Denise Carter', summary: { tagline: 'cashier with experiance', bullets: [], skills: ['cash handling', 'customer service'] },
    experience: [{ title: 'Cashier', company: 'Fictional Corner Store', location: 'Dayton, OH', start: '2019', end: 'Present', summary: '',
      bullets: ['Did the register', 'worked on the register and helped customers', 'helped customers find things in the store', 'Counted the money at closing time and closed the store', 'responsible for counting money at closing'] },
      { title: 'Stock Clerk', company: 'Fictional Grocery', start: '2014', end: '2019', summary: '', bullets: ['stock shelfs', 'unloaded the delivry truck', 'helped customers'] }],
    education: [{ degree: 'High School Diploma', school: 'Oakwood High', date: '2014' }] }),
  after: base({ name: 'Denise Carter', summary: { tagline: 'Cashier with experience', bullets: [], skills: ['Cash handling', 'Customer service'] },
    experience: [{ title: 'Cashier', company: 'Fictional Corner Store', location: 'Dayton, OH', start: '2019', end: 'Present', summary: '',
      bullets: ['Operated the register and helped customers', 'Helped customers find things in the store', 'Counted the money and closed the store at closing time'] },
      { title: 'Stock Clerk', company: 'Fictional Grocery', start: '2014', end: '2019', summary: '', bullets: ['Stocked shelves', 'Unloaded the delivery truck', 'Helped customers'] }],
    education: [{ degree: 'High School Diploma', school: 'Oakwood High', date: '2014' }] })
};

C.changer = {
  label: 'career changer, transferable skills hidden in vague wording',
  before: base({ name: 'Priya Nair', summary: { tagline: 'want to move into customer support', bullets: [], skills: ['record keeping', 'safety'] },
    experience: [{ title: 'Warehouse Associate', company: 'Fictional Supply Co', location: 'Dayton, OH', start: '2018', end: '2026', summary: '',
      bullets: ['answer questions from customers on the phone and when they come in', 'I kept records of shipments so they was correct', 'follow the safety rules on the floor', 'worked with the team'] }],
    education: [{ degree: 'High School Diploma', school: 'Lakeview High', date: '2017' }] }),
  after: base({ name: 'Priya Nair', summary: { tagline: 'Want to move into customer support', bullets: [], skills: ['Record keeping', 'Safety'] },
    experience: [{ title: 'Warehouse Associate', company: 'Fictional Supply Co', location: 'Dayton, OH', start: '2018', end: '2026', summary: '',
      bullets: ['Answered customer questions by phone and in person', 'Kept accurate records of shipments', 'Followed the safety rules on the floor', 'Worked with the team'] }],
    education: [{ degree: 'High School Diploma', school: 'Lakeview High', date: '2017' }] })
};

C.gap = {
  label: 'returning to work after a long gap',
  before: base({ name: 'Dana Whitfield', summary: { tagline: 'going back to work after raising my kids', bullets: [], skills: ['scheduling', 'patience'] },
    experience: [{ title: 'Office Assistant', company: 'Fictional Insurance Office', location: 'Dayton, OH', start: '2006', end: '2012', summary: '',
      bullets: ['answered phones, greet visitors', 'file paperwork every day', 'make appointments for the agents', 'answered the phone'] }],
    volunteer: [{ title: 'Treasurer', organization: 'Fictional PTA', start: '2020', end: '2025', bullets: ['kept the records for the PTA', 'collect money at the school events', 'Keeped records'] }],
    education: [{ degree: 'Associate degree in Office Administration', school: 'Fictional Community College', date: '2006' }] }),
  after: base({ name: 'Dana Whitfield', summary: { tagline: 'Going back to work after raising my kids', bullets: [], skills: ['Scheduling', 'Patience'] },
    experience: [{ title: 'Office Assistant', company: 'Fictional Insurance Office', location: 'Dayton, OH', start: '2006', end: '2012', summary: '',
      bullets: ['Answered phones and greeted visitors', 'Filed paperwork every day', 'Made appointments for the agents'] }],
    volunteer: [{ title: 'Treasurer', organization: 'Fictional PTA', start: '2020', end: '2025', bullets: ['Kept the records for the PTA', 'Collected money at the school events'] }],
    education: [{ degree: 'Associate degree in Office Administration', school: 'Fictional Community College', date: '2006' }] })
};

C.disorganized = {
  label: 'disorganized and repetitive information',
  before: base({ name: 'Jamie Park', summary: { tagline: 'bakery worker', bullets: [], skills: ['baking', 'baking bread'] },
    experience: [{ title: 'Bakery Helper', company: 'Fictional Bakery', location: 'Dayton, OH', start: '2019', end: '2024', summary: '',
      bullets: ['Made bread', 'made the bread in the morning', 'cleaned the oven', 'Worked the counter', 'sold bread at the counter to customers', 'cleaned oven and trays', 'bread and rolls'] }],
    education: [{ degree: 'some college', school: 'Fictional Community College', date: '2018' }] }),
  after: base({ name: 'Jamie Park', summary: { tagline: 'Bakery worker', bullets: [], skills: ['Baking', 'Baking bread'] },
    experience: [{ title: 'Bakery Helper', company: 'Fictional Bakery', location: 'Dayton, OH', start: '2019', end: '2024', summary: '',
      bullets: ['Made bread and rolls in the morning', 'Sold bread at the counter to customers', 'Cleaned the oven and trays'] }],
    education: [{ degree: 'some college', school: 'Fictional Community College', date: '2018' }] })
};

C.polished = {
  label: 'already well written: should be left alone',
  before: base({ name: 'Riley Chen', summary: { tagline: 'Dependable cashier with four years of retail experience', bullets: [], skills: ['Cash handling', 'Inventory counts'] },
    experience: [{ title: 'Lead Cashier', company: 'Fictional Corner Store', location: 'Dayton, OH', start: '2022', end: 'Present', summary: '',
      bullets: ['Processed about 200 transactions per shift with accurate cash drawers', 'Trained 6 new cashiers on the register and returns policy', 'Balanced the drawer and prepared the nightly deposit'] }],
    education: [{ degree: 'High School Diploma', school: 'Oakwood High School', date: '2022' }] }),
  after: null   // the correct result is the same resume
};

C.incomplete = {
  label: 'incomplete but understandable',
  before: base({ name: 'Sam Lee', summary: { tagline: '', bullets: [], skills: ['teamwork'] },
    experience: [{ title: 'Cashier', company: 'Fictional Market', start: '2023', end: '2025', summary: '', bullets: ['cash', 'stock', 'help people find stuff', 'clean'] }],
    education: [] }),
  after: base({ name: 'Sam Lee', summary: { tagline: '', bullets: [], skills: ['Teamwork'] },
    experience: [{ title: 'Cashier', company: 'Fictional Market', start: '2023', end: '2025', summary: '', bullets: ['Handled cash', 'Stocked items', 'Helped people find products', 'Cleaned up'] }],
    education: [] })
};

C.spellingOnly = {
  label: 'clear sentences, but six misspelled words (a spelling-and-grammar-only job)',
  before: base({ name: 'Lena Ortiz', summary: { tagline: 'Retail clerk', bullets: [], skills: ['Cash handling'] },
    experience: [{ title: 'Retail Clerk', company: 'Fictional Dollar Shop', location: 'Dayton, OH', start: '2020', end: '2024', summary: '',
      bullets: ['Rang up purchases for custmers', 'Counted the cash drawer at clossing', 'Stocked shelves with new merchandize', 'Answered questons about prices', 'Cleaned the registar area', 'Greeted customers at the entrence'] }],
    education: [{ degree: 'High School Diploma', school: 'Oakwood High', date: '2020' }] }),
  after: base({ name: 'Lena Ortiz', summary: { tagline: 'Retail clerk', bullets: [], skills: ['Cash handling'] },
    experience: [{ title: 'Retail Clerk', company: 'Fictional Dollar Shop', location: 'Dayton, OH', start: '2020', end: '2024', summary: '',
      bullets: ['Rang up purchases for customers', 'Counted the cash drawer at closing', 'Stocked shelves with new merchandise', 'Answered questions about prices', 'Cleaned the register area', 'Greeted customers at the entrance'] }],
    education: [{ degree: 'High School Diploma', school: 'Oakwood High', date: '2020' }] })
};

module.exports = { C };
