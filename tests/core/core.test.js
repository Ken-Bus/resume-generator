// Unit tests for the shared resume model (what shows, in what order, safe text). No browser, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../resume-core.js');

const TPL = { default: { id: 'partner', style: 'left-rule' }, foreman: { id: 'foreman', style: 'foreman' }, scholar: { id: 'scholar', style: 'centered' } };
const keys = (d, t) => C.sections(C.clean(d), t).map((s) => s.key);

test('blank resume has no placeholder entries and shows no sections', () => {
  const b = C.blank();
  assert.equal(C.hasContent(b), false);
  assert.deepEqual(keys(b, TPL.default), []);
  for (const k of ['experience', 'education', 'certifications', 'projects', 'volunteer', 'awards']) assert.deepEqual(b[k], []);
});

test('empty strings, whitespace, empty bullets and fully blank entries are dropped; nothing is mutated', () => {
  const raw = { name: '  Taylor  ', summary: { tagline: ' ', bullets: ['', '  '], skills: ['', 'Teamwork'] },
    experience: [{ title: '', company: '', bullets: [''] }, { title: 'Cashier', bullets: ['', 'Rang up sales'] }],
    education: [{ degree: '', school: '' }], projects: [{ name: '', description: '', bullets: [] }], awards: ['', ' '] };
  const snap = JSON.stringify(raw);
  const c = C.clean(raw);
  assert.equal(JSON.stringify(raw), snap);
  assert.equal(c.name, 'Taylor');
  assert.equal(c.experience.length, 1);
  assert.deepEqual(c.experience[0].bullets, ['Rang up sales']);
  assert.deepEqual([c.education.length, c.projects.length, c.awards.length], [0, 0, 0]);
  assert.deepEqual(c.summary.skills, ['Teamwork']);
});

test('tolerates missing, null and wrongly typed fields (older or AI-produced data)', () => {
  for (const bad of [null, undefined, 5, 'x', [], { experience: 'no', summary: 7, contact: [] }, { experience: [null, 3, 'x'] }]) {
    const c = C.clean(bad);
    assert.equal(typeof c.name, 'string');
    assert.ok(Array.isArray(c.experience));
    assert.doesNotThrow(() => C.sections(c, TPL.default));
  }
});

test('section order: with experience', () => {
  const d = { name: 'A', summary: { tagline: 'Hi', bullets: [], skills: ['X'] }, experience: [{ title: 'T' }], projects: [{ name: 'P' }], volunteer: [{ title: 'V' }],
    education: [{ degree: 'D' }], certifications: [{ name: 'C' }], awards: ['W'] };
  assert.deepEqual(keys(d, TPL.default), ['summary', 'experience', 'projects', 'volunteer', 'education', 'certifications', 'awards']);
  assert.deepEqual(keys(d, TPL.foreman), ['summary', 'certifications', 'experience', 'projects', 'volunteer', 'education', 'awards']);
  assert.deepEqual(keys(d, TPL.scholar), ['summary', 'education', 'experience', 'projects', 'volunteer', 'certifications', 'awards']);
});

test('section order: no work history leads with education, then projects and volunteering', () => {
  const d = { name: 'A', summary: { tagline: '', bullets: [], skills: ['Teamwork'] }, education: [{ degree: 'D' }], projects: [{ name: 'P' }], volunteer: [{ title: 'V' }], certifications: [{ name: 'C' }] };
  assert.deepEqual(keys(d, TPL.default), ['skills', 'education', 'projects', 'volunteer', 'certifications']);
});

test('skills sit inside the summary when there is summary text, otherwise get their own section', () => {
  assert.deepEqual(keys({ summary: { tagline: 'Hi', skills: ['X'] } }, TPL.default), ['summary']);
  assert.deepEqual(keys({ summary: { skills: ['X'] } }, TPL.default), ['skills']);
});

test('a section appears only when it has content', () => {
  assert.deepEqual(keys({ name: 'Only A Name' }, TPL.default), []);
  assert.deepEqual(keys({ awards: ['x'] }, TPL.default), ['awards']);
});

test('dates and contact line', () => {
  assert.equal(C.dateRange('2020', 'Present'), '2020 – Present');
  assert.equal(C.dateRange('2020', ''), '2020');
  assert.equal(C.dateRange('', 'May 2023'), 'May 2023');
  assert.equal(C.dateRange('', ''), '');
  assert.equal(C.contactLine({ phone: '1', email: '', location: 'X', linkedin: '', website: '' }), '1  |  X');
});

test('pdfSafe keeps Latin letters and typographic punctuation, simplifies the rest and says so', () => {
  const keep = C.pdfSafe('José Müller – “quoted” • € résumé');
  assert.equal(keep.simplified, false);
  assert.equal(keep.text, 'José Müller – “quoted” • € résumé');
  const odd = C.pdfSafe('Zoë Łukasz 日本 🙂');
  assert.equal(odd.simplified, true);
  assert.ok(!/[^\x00-\xff–—‘’“”•€]/.test(odd.text), odd.text);
  assert.ok(odd.text.includes('Zoë'));
});

test('file names are safe', () => {
  assert.equal(C.fileBase('Taylor Rivera'), 'Taylor_Rivera_Resume');
  assert.equal(C.fileBase('../../etc/passwd'), 'etc_passwd_Resume');
  assert.equal(C.fileBase(''), 'Resume');
  assert.equal(C.fileBase('José O\'Neil'), 'José_O_Neil_Resume');
});

test('sinceYear reads a year from free-form dates', () => {
  assert.equal(C.sinceYear('June 2015'), 2015);
  assert.equal(C.sinceYear('2008'), 2008);
  assert.equal(C.sinceYear('last summer'), null);
});
