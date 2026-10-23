// WRITING QUALITY, judged on the WHOLE before/after resume. Eight-plus fictional applicants whose resumes need real editing (misspellings, run-ons,
// inconsistent tense, repetition, vague and fragmentary lines, an already-clear resume). `after` in the corpus is what a good editor would produce
// from only what the person wrote. Each test runs the real guard, the real change assessment, and the real PDF/Word renderers. No AI call.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const I = require('../../netlify/functions/_lib/integrity');
const Core = require('../../resume-core.js');
const Templates = require('../../templates.js');
const render = require('../../netlify/functions/_lib/export-render');
const { pdfText, docxText } = require('./files');
const { C } = require('./quality-corpus');
const clone = (o) => JSON.parse(JSON.stringify(o));
const SECTIONS = ['experience', 'volunteer', 'projects'];
const polishGuard = (before, out, target = 'customer service') => I.guardResume(Core.clean(before), clone(Core.clean(out)), { mode: 'polish', vocabulary: target });
const bullets = (r) => SECTIONS.flatMap((k) => (r[k] || []).flatMap((e) => e.bullets || []));
const allLines = (r) => { const c = Core.clean(r); return [c.summary.tagline, ...c.summary.bullets, ...c.summary.skills, ...SECTIONS.flatMap((k) => c[k].flatMap((e) => [e.summary, e.description, ...(e.bullets || [])]))].filter(Boolean); };
const facts = (r) => { const c = Core.clean(r); return JSON.stringify({ n: c.name, c: c.contact, ed: c.education, ce: c.certifications, aw: c.awards, ex: c.experience.map((e) => [e.title, e.company, e.location, e.start, e.end]), vo: c.volunteer.map((e) => [e.title, e.organization, e.start, e.end]), pr: c.projects.map((e) => e.name) }); };
const MISTAKES = ['resturant', 'peoples', 'yerabook', 'boxs', 'experiance', 'shelfs', 'delivry', 'Keeped', 'custmers', 'clossing', 'merchandize', 'questons', 'registar', 'entrence', 'so they was', ' i ', 'i took', 'i helped', 'i put'];

test('every applicant whose resume needs editing: a good edit passes the guard completely, fixes the mistakes, keeps every fact, and reads as a resume', () => {
  for (const [name, c] of Object.entries(C)) {
    if (!c.after) continue;
    const g = polishGuard(c.before, c.after);
    assert.deepEqual(g.withheld.map((w) => `${w.label}: ${w.reasons.join('; ')}`), [], `${name}: a legitimate improvement was withheld`);
    assert.equal(facts(g.resume), facts(c.before), `${name}: customer facts changed`);
    const text = allLines(g.resume).join('\n');
    for (const bad of MISTAKES) if (allLines(c.before).join('\n').includes(bad)) assert.equal(text.includes(bad), false, `${name}: "${bad}" is still in the accepted resume`);
    for (const b of bullets(Core.clean(g.resume))) {
      assert.match(b, /^[A-Z0-9]/, `${name}: bullet should start with a capital: ${b}`); assert.doesNotMatch(b, /^I\s/, `${name}: first person: ${b}`); assert.doesNotMatch(b, /\s{2,}/);
    }
    SECTIONS.forEach((k) => Core.clean(g.resume)[k].forEach((e) => { const keys = (e.bullets || []).map((x) => x.toLowerCase()); assert.equal(new Set(keys).size, keys.length, `${name}: repeated bullet in ${e.title || e.name}`); }));
    const ch = I.assessChange(Core.clean(c.before), g.resume);
    assert.ok(ch.reworded + ch.minor + ch.cosmetic > 0, `${name}: nothing improved`);
  }
});

test('one questionable line no longer throws away the rest of the entry (the 15-year warehouse worker)', () => {
  const c = C.warehouse;
  const out = clone(c.after); out.experience[0].bullets[3] = 'Drove a forklift and a pallet jack for over ten years';       // an invented number inside one of six improved bullets
  const g = polishGuard(c.before, out);
  const e = g.resume.experience[0].bullets;
  assert.deepEqual(g.withheld.map((w) => w.where), ['experience.0.bullets.3']);
  assert.ok(e.includes('Loaded and unloaded trucks') && e.includes('Counted stock every week') && e.includes('Reported damaged boxes to the supervisor'), JSON.stringify(e));
  assert.ok(e.includes('Trained new people to use the pallet jack') && e.includes('Kept the dock clean'));
  assert.equal(e.join(' ').includes('ten years'), false);
  assert.ok(e.some((b) => /forklift/i.test(b)), 'the customer\'s own forklift line is still there');
  assert.equal(e.length, 6);
});

test('the AI may merge repeats but may not delete something the customer did', () => {
  const c = C.retail;
  const out = clone(c.after); out.experience[0].bullets = ['Operated the register and helped customers'];                   // drops "find things in the store" and "counted the money at closing"
  const g = polishGuard(c.before, out);
  const e = g.resume.experience[0].bullets.join(' | ').toLowerCase();
  assert.match(e, /find things/); assert.match(e, /count/); assert.match(e, /clos/);
  const gone = C.disorganized; const o2 = clone(gone.after); o2.experience[0].bullets = ['Made bread and rolls in the morning'];       // drops selling at the counter and cleaning
  const g2 = polishGuard(gone.before, o2); const e2 = g2.resume.experience[0].bullets.join(' | ').toLowerCase();
  assert.match(e2, /counter/); assert.match(e2, /clean/);
});

test('inventions slipped into otherwise good edits are removed one at a time; the good edits stay', () => {
  const invented = {
    firstPoor: ['volunteer', 0, 0, 'Served food on Sundays to hungry families'],
    retail: ['experience', 0, 0, 'Operated the register daily and helped customers'],
    changer: ['experience', 0, 0, 'Answered customer questions by phone and in person every day'],
    gap: ['experience', 0, 0, 'Answered phones and greeted visitors at the front desk'],
    disorganized: ['experience', 0, 0, 'Made bread and rolls in the morning for 200 customers'],
    spellingOnly: ['experience', 0, 3, 'Answered questions about prices and returns'],
    warehouse: ['experience', 0, 4, 'Trained new people to use the pallet jack and led safety meetings'],
  };
  for (const [name, [k, i, j, line]] of Object.entries(invented)) {
    const out = clone(C[name].after); out[k][i].bullets[j] = line;
    const g = polishGuard(C[name].before, out); const ideal = polishGuard(C[name].before, C[name].after);
    assert.equal(g.resume[k][i].bullets.includes(line), false, `${name}: "${line}" got through`);
    assert.equal(g.withheld.length, 1, `${name}: ${JSON.stringify(g.withheld)}`);
    const keep = (r) => bullets(Core.clean(r)).filter((b) => b !== line); const missing = keep(ideal.resume).filter((b) => !bullets(Core.clean(g.resume)).includes(b));
    assert.ok(missing.length <= 1, `${name}: other improvements were lost: ${JSON.stringify(missing)}`);
  }
});

test('a resume that is already clear is left alone: an unchanged answer is "nothing to improve", and trivial dressing-up is not a rewrite', () => {
  const b = C.polished.before; const same = I.assessChange(Core.clean(b), Core.clean(b));
  assert.deepEqual(same, { reworded: 0, minor: 0, cosmetic: 0, unchanged: 6, dropped: 0 });
  const dressed = clone(b); dressed.experience[0].bullets[0] = 'Processed about 200 transactions per shift with exact cash drawers';
  assert.equal(I.assessChange(Core.clean(b), Core.clean(dressed)).reworded, 0, 'a one-word synonym is not a rewrite');
  const bad = clone(b); bad.experience[0].bullets[1] = 'Trained 60 new cashiers on the register and returns policy';
  assert.equal(polishGuard(b, bad).resume.experience[0].bullets[1], b.experience[0].bullets[1], 'the customer\'s own figure is kept');
});

test('what is accepted is what is downloaded: PDF and Word, all 12 templates, contain the corrected wording and none of the mistakes', async () => {
  const squash = (x) => x.replace(/\s+/g, '').toLowerCase();
  for (const [name, c] of Object.entries(C)) {
    if (!c.after) continue;
    const g = polishGuard(c.before, c.after); const final = g.resume; const want = allLines(final).map(squash);
    for (const tpl of Templates.TEMPLATES) {
      const pdf = squash(pdfText(Buffer.from(render.renderPDF(final, tpl, false).buffer)));
      const word = squash(docxText(Buffer.from((await render.renderWord(final, tpl, false)).buffer)));
      for (const w of want) { assert.ok(pdf.includes(w), `${name}/${tpl.id}: PDF is missing "${w.slice(0, 40)}"`); assert.ok(word.includes(w), `${name}/${tpl.id}: Word is missing "${w.slice(0, 40)}"`); }
      for (const bad of MISTAKES.filter((m) => m.trim() === m && m.length >= 6 && allLines(c.before).join('\n').includes(m) && !allLines(final).join('\n').includes(m))) {
        assert.equal(pdf.includes(squash(bad)), false, `${name}/${tpl.id}: PDF still has "${bad}"`); assert.equal(word.includes(squash(bad)), false, `${name}/${tpl.id}: Word still has "${bad}"`);
      }
    }
  }
});

test('the prompt asks for the whole job: spelling, tense, run-ons, repetition, vague words, order, plain language, and keeps every duty', () => {
  const polish = require('../../netlify/functions/polish-resume');
  const text = polish._buildPrompt(Core.clean(C.warehouse.before), 'warehouse', 'experienced');
  for (const must of ['SPELLING AND GRAMMAR', 'Fix small mistakes too', 'FORM AND TENSE', 'present tense for an entry whose end date is "Present"', 'RUN-ONS AND FRAGMENTS', 'separate bullets, one duty each',
    'REPETITION', 'Never delete a duty that is stated only once', 'VAGUE WORDS', 'ORDER', 'LEAVE CLEAR LINES ALONE', 'No corporate jargon', 'never add a skill', 'Handled cash', 'Loaded and unloaded trucks'])
    assert.ok(text.includes(must), must);
  const nums = [...text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])); assert.deepEqual(nums, [...Array(nums.length).keys()].map((i) => i + 1), 'rules are numbered 1..n without gaps or repeats');
  assert.equal(/do not (swap|replace) one word for a synonym, add a single word/i.test(text), false, 'no instruction to skip small fixes');
});
