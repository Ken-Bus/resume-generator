// Ten fictional applicants for the stress tests, deliberately different in how much they tell us and how well they say it.
// Nobody here is a real person; every company, school and address is made up.
const clone = (o) => JSON.parse(JSON.stringify(o));
const C = (email) => ({ email, location: 'Dayton, OH' });

const P = {};

// 1. First-time job seeker, almost nothing.
P.firstMinimal = { name: 'Alex Moreno', contact: C('alex.moreno@example.com'), summary: { tagline: '', bullets: [], skills: ['Teamwork'] }, experience: [],
  education: [{ degree: 'High School Diploma', school: 'Lakeview High School', date: '2027' }], certifications: [], volunteer: [], awards: [],
  projects: [{ name: 'Yearbook Club', description: '', bullets: ['took photos at games'] }] };

// 2. First-time job seeker with detailed school and volunteer projects.
P.firstDetailed = { name: 'Taylor Rivera', contact: C('taylor.rivera@example.com'), summary: { tagline: 'Seeking a customer service position', bullets: [], skills: ['Teamwork', 'Customer service'] }, experience: [],
  education: [{ degree: 'High School Diploma', school: 'Oakwood High School', date: '2026', honors: 'Honor roll' }], certifications: [{ name: 'Food Handler Course', date: '2026' }], awards: [],
  projects: [{ name: 'School Food Drive', description: '', bullets: ['Asked classmates to donate canned food', 'Sorted and counted donated items', 'Helped organize food for pickup'] },
    { name: 'Science Fair', description: 'Built a model of a water filter', bullets: ['Tested three filter designs', 'Wrote the results on a poster'] }],
  volunteer: [{ title: 'Volunteer', organization: 'Community Food Pantry', start: '2025', end: 'Present', bullets: ['Packed grocery boxes on Saturdays', 'Greeted families as they arrived'] }] };

// 3. Experienced worker, 10-20 years.
P.experienced = { name: 'Michael Johnson', contact: C('mj@example.com'), summary: { tagline: 'Warehouse associate', bullets: ['Working at Fictional Freight Co since 2004'], skills: ['Forklift safety', 'Teamwork'] },
  experience: [
    { title: 'Shift Lead', company: 'Fictional Freight Co', location: 'Dayton, OH', start: '2015', end: 'Present', summary: '', bullets: ['Showed new people how to use the pallet jack', 'Checked orders for accuracy', 'Helped the dock team load trucks', 'Kept the dock clean and safe'] },
    { title: 'Warehouse Associate', company: 'Fictional Freight Co', location: 'Dayton, OH', start: '2004', end: '2015', summary: '', bullets: ['Loaded and unloaded trucks', 'Worked with the shipping team', 'Counted stock each week', 'Reported damaged boxes'] },
    { title: 'Stock Clerk', company: 'Fictional Grocery', location: 'Dayton, OH', start: '1999', end: '2004', summary: '', bullets: ['Stocked shelves', 'Helped customers find items', 'Cleaned the aisles', 'Handled returns'] }],
  education: [{ degree: 'High School Diploma', school: 'Oakwood High', date: '1999' }], certifications: [{ name: 'Forklift Safety Course', org: 'Fictional Safety Council', date: '2018' }], projects: [], volunteer: [], awards: [] };

// 4. Career changer with transferable skills.
P.changer = { name: 'Priya Nair', contact: C('priya.nair@example.com'), summary: { tagline: 'Seeking a customer support role', bullets: [], skills: ['Teamwork', 'Keeping records'] },
  experience: [{ title: 'Warehouse Associate', company: 'Fictional Supply Co', location: 'Dayton, OH', start: '2018', end: '2026', summary: '',
    bullets: ['answered customer questions by phone and in person', 'kept accurate records of shipments', 'followed safety rules on the floor'] }],
  education: [{ degree: 'High School Diploma', school: 'Lakeview High', date: '2017' }], certifications: [], projects: [], volunteer: [], awards: [] };

// 5. Returning to work after a long gap.
P.returning = { name: 'Dana Whitfield', contact: C('dana.whitfield@example.com'), summary: { tagline: 'Returning to work after raising a family', bullets: [], skills: ['Scheduling', 'Patience'] },
  experience: [{ title: 'Office Assistant', company: 'Fictional Insurance Office', location: 'Dayton, OH', start: '2006', end: '2012', summary: '', bullets: ['Answered the phones and greeted visitors', 'Filed paperwork each day', 'Scheduled appointments for the agents'] }],
  education: [{ degree: 'Associate degree in Office Administration', school: 'Fictional Community College', date: '2006' }], certifications: [], awards: [], projects: [],
  volunteer: [{ title: 'Treasurer', organization: 'Fictional PTA', start: '2020', end: '2025', bullets: ['Kept the PTA records', 'Collected money at school events'] }] };

// 6. Several jobs, projects and certifications.
P.multi = { name: 'Jordan Ellis', contact: { phone: '(555) 010-0101', email: 'jordan.ellis@example.com', location: 'Dayton, OH', linkedin: 'linkedin.com/in/jordan-ellis-example', website: 'jordanellis.example.com' },
  summary: { tagline: 'Retail associate', bullets: ['Three years of store experience'], skills: ['Customer service', 'Cash handling'] },
  experience: [{ title: 'Retail Associate', company: 'Fictional Maple Market', location: 'Dayton, OH', start: '2023', end: 'Present', summary: 'Front-of-store work', bullets: ['Assisted customers at the register', 'Counted the drawer at closing'] },
    { title: 'Stock Associate', company: 'Fictional Pine Outlet', location: 'Dayton, OH', start: '2021', end: '2023', summary: '', bullets: ['Restocked shelves', 'Helped unload deliveries'] }],
  education: [{ degree: 'Associate degree in Business', school: 'Fictional Community College', date: '2023', honors: 'Dean\'s list' }], awards: ['Employee of the Month, May 2024'],
  certifications: [{ name: 'Food Handler Course', org: 'Fictional Health Dept', date: '2022' }, { name: 'Cash Handling Basics', date: '2023' }],
  projects: [{ name: 'Store Display Project', description: 'Set up a window display', bullets: ['Arranged products by color', 'Helped paint signs'] }, { name: 'Inventory Spreadsheet', description: 'Tracked stock levels', bullets: ['Entered weekly counts'] }],
  volunteer: [{ title: 'Helper', organization: 'Fictional Animal Shelter', start: '2022', end: '2023', bullets: ['Walked dogs on weekends'] }] };

// 7. Sparse, poorly written (typos, lower case, run-ons).
P.poor = { name: 'Sam Lee', contact: { email: 'sam.lee@example.com' }, summary: { tagline: '', bullets: [], skills: ['Teamwork'] },
  experience: [{ title: 'Cashier', company: 'Fictional Market', bullets: ['i answer phone and recieve payments and stuff', 'rang up items', 'handle money'] }], education: [], certifications: [], projects: [], volunteer: [], awards: [] };

// 8. Already well written: little or nothing to improve.
P.polished = { name: 'Riley Chen', contact: C('riley.chen@example.com'), summary: { tagline: 'Dependable cashier with four years of retail experience', bullets: [], skills: ['Cash handling', 'Inventory counts'] },
  experience: [{ title: 'Lead Cashier', company: 'Fictional Corner Store', location: 'Dayton, OH', start: '2022', end: 'Present', summary: '', bullets: ['Processed about 200 transactions per shift with accurate cash drawers', 'Trained 6 new cashiers on the register and returns policy', 'Balanced the drawer and prepared the nightly deposit'] }],
  education: [{ degree: 'High School Diploma', school: 'Oakwood High School', date: '2022' }], certifications: [], projects: [], volunteer: [], awards: [] };

// 9. Long resume, close to the application's limits (built below).
P.long = null;

// 10. Incomplete, inconsistent, ambiguous.
P.ambiguous = { name: 'Jamie Park', contact: { email: 'jamie.park@example.com' }, summary: { tagline: 'various work', bullets: [], skills: [] },
  experience: [{ title: '', company: 'Fictional Bakery', start: '2019', end: '2017', summary: '', bullets: ['various duties', 'various duties', 'Did stuff with the oven and the counter and also the oven'] },
    { title: 'Helper', company: '', bullets: ['worked on things'] }],
  education: [{ degree: 'some college', school: '', date: '' }], certifications: [], projects: [{ name: 'Thing', description: '', bullets: [] }], volunteer: [], awards: [] };

function buildLong(limits, cfg) {
  const o = clone(P.experienced);
  const total = limits.maxJsonChars(cfg.TAILOR_MAX_TOKENS);
  o.experience = [];
  let i = 0;
  while (JSON.stringify(o).length < total - 900) {
    o.experience.push({ title: `Associate ${i}`, company: `Fictional Company ${i}`, location: 'Dayton, OH', start: `${1990 + (i % 30)}`, end: `${1991 + (i % 30)}`, summary: '',
      bullets: [`Counted stock for team ${i} each week`, `Answered customer questions at counter ${i} and kept good notes`, `Loaded and unloaded trucks on dock ${i}`] });
    i++;
  }
  return o;
}

module.exports = { P, clone, buildLong };
