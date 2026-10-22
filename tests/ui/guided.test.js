// Browser tests for the guided builder, the section model in the preview, and the PDF/Word exports.
// Endpoints are mocked and every call is recorded; nothing leaves the machine. Fictional applicants only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const { exportApi } = require('./export-api');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-ui-'));

function serve() {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// ── helpers that read the exported files ─────────────────────────────────────
// PDF text two ways: poppler when installed, and always by inflating the PDF's own streams and reading its text operators.
// (An image-only PDF, as the old export produced, has none of these operators.)
function pdfOperatorText(buf) {
  let out = '';
  let i = 0;
  while ((i = buf.indexOf('stream', i)) >= 0) {
    const start = buf[i + 6] === 13 ? i + 8 : i + 7; const end = buf.indexOf('endstream', start); if (end < 0) break;
    try { out += zlib.inflateSync(buf.subarray(start, end)).toString('latin1') + '\n'; } catch (e) { /* not a flate stream */ }
    i = end + 9;
  }
  const CP1252 = { 0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™' };
  out = out.replace(/[\x80-\x9f]/g, (c) => CP1252[c.charCodeAt(0)] || c);
  const strings = [];
  out.replace(/\(((?:\\.|[^\\)])*)\)\s*Tj/g, (_, s) => { strings.push(s.replace(/\\(.)/g, '$1')); return ''; });
  return strings.join('\n');
}
function pdfText(file) {
  const buf = fs.readFileSync(file);
  const ops = pdfOperatorText(buf);
  const probe = spawnSync('pdftotext', ['-v']);
  const poppler = probe.error ? null : spawnSync('pdftotext', ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8' }).stdout;
  return { ops, poppler, images: (buf.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length, pages: (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length };
}
function docxText(file) {                      // minimal zip reader: finds word/document.xml and inflates it
  const b = fs.readFileSync(file);
  let eocd = b.length - 22; while (eocd > 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = b.readUInt32LE(eocd + 16); const n = b.readUInt16LE(eocd + 10);
  for (let k = 0; k < n; k++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nlen);
    if (name === 'word/document.xml') {
      const lnlen = b.readUInt16LE(off + 26), lxlen = b.readUInt16LE(off + 28); const data = b.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
      const xml = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
      return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error('document.xml not found');
}

const FIRST_TIMER = {
  name: 'Taylor Rivera', contact: { phone: '(555) 010-0199', email: 'taylor.rivera@example.com', location: 'Dayton, OH', linkedin: '', website: '' },
  summary: { tagline: 'Seeking a customer service position', bullets: [], skills: ['Teamwork', 'Customer service'] },
  experience: [], education: [{ degree: 'High School Diploma', school: 'Oakwood High School', location: '', date: '2026', honors: 'Honor roll' }],
  certifications: [{ name: 'Food Handler Course', org: '', date: '2026' }],
  projects: [{ name: 'School food drive', description: 'Collected canned food for a local pantry', bullets: ['Asked classmates to donate', 'Sorted and counted the cans'] }],
  volunteer: [{ title: 'Volunteer', organization: 'Community Food Pantry', location: '', start: '2025', end: 'Present', bullets: ['Packed grocery boxes on Saturdays'] }], awards: []
};
const WORKER = {
  name: 'Michael Johnson', contact: { phone: '', email: 'mj@example.com', location: 'Dayton, OH', linkedin: '', website: '' },
  summary: { tagline: 'Warehouse associate', bullets: ['Eight years on the loading dock'], skills: ['Forklift safety'] },
  experience: [{ title: 'Warehouse Associate', company: 'Fictional Freight Co', location: 'Dayton, OH', start: '2016', end: 'Present', summary: 'Receiving dock for a regional warehouse.',
    bullets: ['Loaded and unloaded trucks', 'Checked orders for accuracy'] }],
  education: [{ degree: 'High School Diploma', school: 'Oakwood High', location: '', date: '2016', honors: '' }], certifications: [], projects: [], volunteer: [], awards: []
};

test('guided builder, section model and exports (Chromium, mocked endpoints)', async (t) => {
  if (!fs.existsSync(PW) || !fs.existsSync(CHROME)) { t.skip('Playwright/Chromium not available'); return; }
  const { chromium } = require(PW);
  const server = await serve(); const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME });

  const verifyOk0 = () => ({ status: 200, json: { valid: true, usesRemaining: 5, maxUses: 5 } });
  async function open(api0 = {}, viewport = { width: 1280, height: 900 }, extra = {}) {
    const api = { 'verify-license': verifyOk0, 'export-resume': exportApi(['FG-TEST-AAAA']), ...api0 };
    const ctx = await browser.newContext({ acceptDownloads: true, viewport, ...extra }); const page = await ctx.newPage();
    const calls = []; const external = []; const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.includes('/.netlify/functions/')) {
        const name = url.split('/.netlify/functions/')[1];
        let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (e) {}
        calls.push({ name, body });
        const r = await (api[name] || (() => ({ status: 500, json: { error: 'unmocked' } })))(body, calls.length);
        if (r.raw) return route.fulfill({ status: r.status, headers: r.headers, body: Buffer.from(r.body || '', r.isBase64Encoded ? 'base64' : 'utf8') });
        return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.json) });
      }
      if (url.startsWith(base)) return route.continue();
      external.push(url); return route.abort();
    });
    await page.goto(base + '/index.html');
    return { page, calls, external, errors, close: () => ctx.close() };
  }
  const verifyOk = () => ({ status: 200, json: { valid: true, usesRemaining: 5, maxUses: 5 } });
  const paidCalls = (s) => s.calls.filter((c) => !['verify-license', 'export-resume'].includes(c.name));      // downloads are authorization checks, never paid
  async function unlockViaWizard(s, path = 'first') {
    await s.page.fill('#gate-code-input', 'FG-TEST-AAAA'); await s.page.click('#gate-unlock-btn');
    await s.page.waitForSelector('#license-gate', { state: 'hidden' });
    await s.page.click(path === 'first' ? '#start-first' : '#start-returning');
    await s.page.waitForSelector('#panel-guide .wiz-title');
  }
  async function licensed(s) {
    await s.page.fill('#gate-code-input', 'FG-TEST-AAAA'); await s.page.click('#gate-unlock-btn');
    await s.page.waitForSelector('#license-gate', { state: 'hidden' });
  }
  async function licensedSample(s) { await licensed(s); await s.page.evaluate(() => loadSample()); }
  async function load(s, data, template) {
    await s.page.evaluate(([d, tpl]) => { state.data = d; if (tpl) selectTemplate(tpl); renderEditFields(); renderPreview(); }, [data, template]);
  }
  async function download(s, btn, name) {
    const [dl] = await Promise.all([s.page.waitForEvent('download', { timeout: 30000 }), s.page.click(btn)]);
    const f = path.join(TMP, name); await dl.saveAs(f); await s.page.waitForTimeout(600); return f;
  }

  await t.test('three clearly labelled start paths are offered; paste path still works and focuses the box', async () => {
    const s = await open({});
    const labels = await s.page.$$eval('.start-card strong', (els) => els.map((e) => e.textContent));
    assert.deepEqual(labels, ['Create My First Resume', 'I’ve Worked Before / Need a New Resume', 'I Already Have a Resume']);
    await s.page.click('.gate-sample-link');                                   // gate out of the way
    await s.page.evaluate(() => { state.data = null; document.getElementById('start-paths').style.display = 'block'; });
    await s.page.click('#start-paste');
    assert.equal(await s.page.evaluate(() => document.activeElement.id), 'resume-input');
    assert.equal(paidCalls(s).length, 0); assert.deepEqual(s.errors, []); await s.close();
  });

  await t.test('starting the builder needs a verified code but never uses a generation: only verify-license is called', async () => {
    const s = await open({ 'verify-license': verifyOk });
    await s.page.click('.gate-sample-link');                                   // browse as an unlicensed visitor
    await s.page.evaluate(() => { state.data = null; syncChrome(); });
    await s.page.click('#start-first');
    assert.equal(await s.page.isVisible('#license-gate'), true);               // gated
    assert.match(await s.page.innerText('#gate-error'), /never uses one of your generations/);
    assert.equal(s.calls.length, 0);
    await s.page.fill('#gate-code-input', 'FG-TEST-AAAA'); await s.page.click('#gate-unlock-btn');
    await s.page.waitForSelector('#panel-guide .wiz-title');
    assert.deepEqual([...new Set(s.calls.map((c) => c.name))], ['verify-license']);   // no parse-resume, tailor-resume or consume-generation
    assert.match(await s.page.innerText('#license-badge'), /5 of 5/);          // balance untouched
    await s.close();
  });

  await t.test('choosing the free sample cancels a queued builder start', async () => {
    const s = await open({ 'verify-license': verifyOk });
    await s.page.click('.gate-sample-link');                                   // browse unlicensed
    await s.page.click('text=Start a new resume with the guided builder');     // asks for a code
    await s.page.waitForSelector('#license-gate', { state: 'visible' });
    assert.equal(await s.page.evaluate(() => typeof pendingGeneration), 'function');
    await s.page.click('.gate-sample-link');
    assert.equal(await s.page.evaluate(() => state.wizard), null);
    assert.equal(await s.page.evaluate(() => pendingGeneration), null); await s.close();
  });

  await t.test('first-time path end to end: no work history, live preview, section order, no paid calls', async () => {
    const s = await open({ 'verify-license': verifyOk });
    await unlockViaWizard(s, 'first');
    assert.equal(await s.page.isVisible('#export-bar'), false);                // nothing to export yet
    const preview = () => s.page.innerText('#resume-preview');
    assert.doesNotMatch(await preview(), /EXPERIENCE|EDUCATION|SUMMARY/i);     // empty headings are hidden

    await s.page.fill('input[placeholder^="e.g. customer service"]', 'customer service');
    assert.equal(await s.page.inputValue('#wiz-tagline'), 'Seeking a customer service position');
    assert.match(await preview(), /Seeking a customer service position/);
    await s.page.click('.wiz-next');                                           // → contact
    await s.page.fill('input[placeholder="e.g. Taylor Rivera"]', 'Taylor Rivera');
    await s.page.fill('input[placeholder="e.g. name@example.com"]', 'taylor.rivera@example.com');
    assert.match(await preview(), /Taylor Rivera/i); assert.equal(await s.page.isVisible('#export-bar'), true);
    await s.page.click('.wiz-next');                                           // → work: "Have you worked before?"
    await s.page.click('.wiz-choice:has-text("Not yet")');
    assert.match(await s.page.innerText('#panel-guide'), /No work history yet\? No problem/);
    await s.page.click('.wiz-next');                                           // → school
    await s.page.click('.wiz-add:has-text("Add a school")');
    await s.page.fill('input[placeholder="e.g. Oakwood High School"]', 'Oakwood High School');
    await s.page.selectOption('select.wiz-input', 'High school diploma');
    await s.page.fill('input[placeholder="e.g. 2026"]', '2026');
    assert.deepEqual(await s.page.evaluate(() => [state.data.education[0].degree, state.data.education[0].date]), ['High school diploma', '2026']);
    await s.page.click('.wiz-next');                                           // → projects & more
    await s.page.click('.wiz-add:has-text("Add a project")');
    await s.page.fill('input[placeholder="e.g. School food drive"]', 'School food drive');
    await s.page.fill('textarea[placeholder^="Asked classmates"]', 'Asked classmates to donate\n\nSorted and counted the cans\n');
    await s.page.click('.wiz-next');                                           // → skills
    await s.page.check('.wiz-check:has-text("Teamwork") input');
    await s.page.fill('input[placeholder^="e.g. Spanish"]', 'Spanish, Microsoft Word');
    const text = await preview();
    const order = ['EDUCATION', 'PROJECTS'].map((h) => text.indexOf(h));
    assert.ok(order[0] > 0 && order[1] > order[0], `education before projects: ${order}`);
    assert.doesNotMatch(text, /EXPERIENCE/);                                  // no work history: no empty heading, no fake entry
    assert.match(text, /Asked classmates to donate/); assert.match(text, /Spanish – Microsoft Word|Teamwork – Spanish/);
    const data = await s.page.evaluate(() => state.data);
    assert.deepEqual(data.projects[0].bullets, ['Asked classmates to donate', 'Sorted and counted the cans']);   // blank lines dropped
    await s.page.click('.wiz-next');                                           // → review
    assert.match(await s.page.innerText('#panel-guide'), /None yet\. That's okay!/);
    await s.page.click('.wiz-next');                                           // → Open in Editor
    assert.equal(await s.page.evaluate(() => state.activePanel), 'edit');
    assert.match(await s.page.inputValue('#edit-fields input.field-input'), /Taylor Rivera/);   // Edit Fields shows the same data
    assert.equal(paidCalls(s).length, 0); assert.deepEqual(s.errors, []); await s.close();
  });

  await t.test('skip, Back, step buttons and returning to edit answers all keep the data', async () => {
    const s = await open({ 'verify-license': verifyOk });
    await unlockViaWizard(s, 'returning');
    await s.page.click('.wiz-next');                                           // goal → contact
    await s.page.fill('input[placeholder="e.g. Taylor Rivera"]', 'Sam Lee');
    await s.page.click('.wiz-skip'); await s.page.click('.wiz-skip'); await s.page.click('.wiz-skip');   // skip work, school, extras
    assert.match(await s.page.innerText('.wiz-progress'), /Step 5 of 7/i);
    await s.page.click('.wiz-back'); await s.page.click('.wiz-dot:has-text("You")');
    assert.equal(await s.page.inputValue('input[placeholder="e.g. Taylor Rivera"]'), 'Sam Lee');
    await s.page.click('.wiz-dot:has-text("Review")');
    assert.match(await s.page.innerText('#panel-guide'), /Sam Lee/);
    await s.page.click('.wiz-review-row:has-text("You") .wiz-link');           // "Edit" from the review screen jumps back
    assert.match(await s.page.innerText('.wiz-progress'), /Step 2 of 7/i);
    assert.equal(paidCalls(s).length, 0); await s.close();
  });

  await t.test('long-time worker path: tick-what-is-true adds and removes exact lines; "since" line comes from the dates', async () => {
    const s = await open({ 'verify-license': verifyOk });
    await unlockViaWizard(s, 'returning');
    await s.page.click('.wiz-dot:has-text("Work")');
    await s.page.fill('input[placeholder^="e.g. Cashier"]', 'Warehouse Associate');
    await s.page.fill('input[placeholder^="e.g. Maple Market"]', 'Fictional Freight Co');
    await s.page.fill('input[placeholder="e.g. June 2019"]', 'March 2012');
    await s.page.check('text=I still work here');
    assert.equal(await s.page.evaluate(() => state.data.experience[0].end), 'Present');
    await s.page.click('.wiz-chip:has-text("since 2012")');
    assert.deepEqual(await s.page.evaluate(() => state.data.summary.bullets), ['Working at Fictional Freight Co since 2012']);
    await s.page.check('.wiz-check:has-text("Handled cash") input');
    await s.page.check('.wiz-check:has-text("Showed new coworkers") input');
    assert.deepEqual(await s.page.evaluate(() => state.data.experience[0].bullets), ['Handled cash and card payments', 'Showed new coworkers how to do their tasks']);
    assert.match(await s.page.inputValue('#wiz-lines-experience-0'), /Handled cash/);
    await s.page.uncheck('.wiz-check:has-text("Handled cash") input');
    assert.deepEqual(await s.page.evaluate(() => state.data.experience[0].bullets), ['Showed new coworkers how to do their tasks']);
    assert.equal((await s.page.innerText('#panel-guide')).includes('Supervised or led other workers (only if you really did)'), true);   // offered, never pre-ticked
    assert.equal(await s.page.isChecked('.wiz-check:has-text("Supervised") input'), false);
    await s.page.click('text=Add another role at Fictional Freight Co');
    assert.equal(await s.page.evaluate(() => state.data.experience.length), 2);
    assert.equal(await s.page.evaluate(() => state.data.experience[1].company), 'Fictional Freight Co');
    assert.equal(paidCalls(s).length, 0); await s.close();
  });

  await t.test('blank, partial and single-field resumes never show empty headings or crash, and exports refuse an empty resume politely', async () => {
    const s = await open({ 'verify-license': verifyOk });
    await licensedSample(s);
    const blank = { name: '', contact: {}, summary: { tagline: '', bullets: [''], skills: [''] }, experience: [{ title: '', company: '', bullets: [''] }], education: [{ degree: '' }], certifications: [], projects: [{ name: '' }], volunteer: [], awards: [''] };
    await load(s, blank);
    const txt = await s.page.innerText('#resume-preview');
    assert.doesNotMatch(txt, /EXPERIENCE|EDUCATION|PROJECTS|SUMMARY|SKILLS|CERTIFICATIONS|AWARDS/i);
    assert.equal(await s.page.isVisible('#export-bar'), false);
    await s.page.evaluate(() => document.getElementById('export-bar').style.display = 'flex');
    await s.page.click('#btn-pdf'); assert.match(await s.page.innerText('#export-notice'), /Add some details/);
    for (const partial of [{ name: 'Only A Name' }, { education: [{ school: 'Only School' }] }, { summary: { skills: ['One skill'] } }, { projects: [{ name: 'P' }] }, { awards: ['A'] }]) {
      await load(s, partial);
      const f = await download(s, '#btn-pdf', 'partial.pdf'); const r = pdfText(f);
      assert.ok(r.ops.length > 3, JSON.stringify(partial)); assert.equal(r.images, 0);
      await download(s, '#btn-word', 'partial.docx');
    }
    assert.deepEqual(s.errors, []); await s.close();
  });


  // ───────── plain-language usability pass ─────────
  await t.test('goal step: no "Headline" jargon; one-line introduction is explained in plain words; the three audiences are offered and the choice is remembered', async () => {
    const s = await open({}); await unlockViaWizard(s, 'first');
    const text = await s.page.innerText('#panel-guide');
    assert.doesNotMatch(text, /headline|tagline/i);
    assert.match(text, /One-line introduction/); assert.match(text, /short sentence at the top of your resume that tells an employer who you are/);
    assert.match(text, /Not sure\? Leave it blank/);
    assert.deepEqual(await s.page.$$eval('input[name="wiz-profile"]', (els) => els.map((e) => e.checked)), [true, false, false]);   // first path starts as "first resume"
    assert.match(text, /First resume\? That’s okay/);
    await s.page.check('input[name="wiz-profile"] >> nth=2');
    assert.equal(await s.page.evaluate(() => state.wizard.profile), 'changer');
    assert.match(await s.page.innerText('#panel-guide .wiz-note'), /Changing direction\?/);
    await s.page.click('.wiz-dot:has-text("Review")');
    assert.doesNotMatch(await s.page.innerText('#panel-guide'), /headline|tagline/i);
    await s.close();
    const s2 = await open({}); await unlockViaWizard(s2, 'returning');
    assert.equal(await s2.page.evaluate(() => state.wizard.profile), 'experienced');
    assert.equal(await s2.page.locator('input[name="wiz-profile"]').nth(1).isChecked(), true); await s2.close();
  });

  await t.test('education: qualification, subject and status are separate questions, composed into the resume correctly (completed, ongoing, and not-listed qualifications)', async () => {
    const s = await open({}); await unlockViaWizard(s, 'first'); await s.page.click('.wiz-dot:has-text("School")');
    await s.page.click('.wiz-add:has-text("Add a school")');
    const edu = () => s.page.evaluate(() => [state.data.education[0].degree, state.data.education[0].date]);
    const text = await s.page.innerText('#panel-guide');
    for (const label of ['School or college', 'Qualification', 'Where are you with it?', 'I finished this', 'I’m still studying']) assert.ok(text.includes(label), label);
    assert.equal(await s.page.locator('input[placeholder="e.g. Business, Nursing, Welding"]').count(), 0);                 // no subject question until a qualification needs one
    await s.page.selectOption('select.wiz-input', 'High school diploma');
    assert.equal(await s.page.locator('input[placeholder="e.g. Business, Nursing, Welding"]').count(), 0);                 // a diploma has no subject
    await s.page.selectOption('select.wiz-input', 'Associate degree');
    await s.page.fill('input[placeholder="e.g. Business, Nursing, Welding"]', 'Nursing');
    await s.page.fill('input[placeholder="e.g. 2026"]', '2025');
    assert.deepEqual(await edu(), ['Associate degree in Nursing', '2025']);                                                 // completed: plain year
    await s.page.check('text=I’m still studying');
    assert.match(await s.page.innerText('#panel-guide'), /Year you expect to finish/);
    assert.deepEqual(await edu(), ['Associate degree in Nursing', 'Expected 2025']);                                        // ongoing: clearly marked
    await s.page.fill('input[placeholder="e.g. 2026"]', '');
    assert.deepEqual(await edu(), ['Associate degree in Nursing', 'In progress']);                                          // no year is fine
    await s.page.selectOption('select.wiz-input', 'Other');
    await s.page.fill('input[placeholder="e.g. Nursing assistant program"]', 'Nursing assistant program');
    assert.deepEqual(await edu(), ['Nursing assistant program in Nursing', 'In progress']);
    await s.page.fill('input[placeholder="e.g. Business, Nursing, Welding"]', '');
    assert.deepEqual(await edu(), ['Nursing assistant program', 'In progress']);
    // preview and exports show it the way an employer expects
    assert.match(await s.page.innerText('#resume-preview'), /Nursing assistant program/); assert.match(await s.page.innerText('#resume-preview'), /In progress/);
    await s.close();
  });

  await t.test('education edited in the regular editor (or by AI) is read back correctly when returning to the builder; it never wipes what was typed there', async () => {
    const s = await open({}); await unlockViaWizard(s, 'first'); await s.page.click('.wiz-dot:has-text("School")');
    await s.page.click('.wiz-add:has-text("Add a school")'); await s.page.selectOption('select.wiz-input', 'High school diploma'); await s.page.fill('input[placeholder="e.g. 2026"]', '2026');
    await s.page.evaluate(() => { state.data.education[0].degree = 'Bachelor’s degree in Business'; state.data.education[0].date = 'Expected 2027'; renderEditFields(); });
    await s.page.click('.wiz-dot:has-text("Skills")'); await s.page.click('.wiz-dot:has-text("School")');
    assert.equal(await s.page.inputValue('select.wiz-input'), 'Bachelor’s degree');
    assert.equal(await s.page.inputValue('input[placeholder="e.g. Business, Nursing, Welding"]'), 'Business');
    assert.equal(await s.page.locator('input[name^="wiz-edu-status"] >> nth=1').isChecked(), true);
    assert.equal(await s.page.inputValue('input[placeholder="e.g. 2026"]'), '2027');
    assert.deepEqual(await s.page.evaluate(() => [state.data.education[0].degree, state.data.education[0].date]), ['Bachelor’s degree in Business', 'Expected 2027']);
    await s.page.evaluate(() => { state.data.education[0].degree = 'Diploma of Hospitality (Level 3)'; });             // something the questions cannot express
    await s.page.click('.wiz-dot:has-text("Skills")'); await s.page.click('.wiz-dot:has-text("School")');
    assert.equal(await s.page.inputValue('select.wiz-input'), 'Other');
    assert.equal(await s.page.inputValue('input[placeholder="e.g. Nursing assistant program"]'), 'Diploma of Hospitality (Level 3)');
    assert.equal(await s.page.evaluate(() => state.data.education[0].degree), 'Diploma of Hospitality (Level 3)');
    await s.close();
  });

  await t.test('projects, volunteering, training and skills explain themselves with plain definitions and examples', async () => {
    const s = await open({}); await unlockViaWizard(s, 'first'); await s.page.click('.wiz-dot:has-text("Projects")');
    let text = await s.page.innerText('#panel-guide');
    for (const needle of ['Something you made, organized or worked on, for school, a club, your community, or on your own', 'a school food drive, a science fair project, a family budget spreadsheet',
      'Unpaid roles and groups you take part in', 'Classes, courses or certificates you finished', 'Only list ones you really completed']) assert.ok(text.includes(needle), needle);
    await s.page.click('.wiz-add:has-text("Add a project")'); await s.page.click('.wiz-add:has-text("Add volunteering or an activity")'); await s.page.click('.wiz-add:has-text("Add training or a course")');
    text = await s.page.innerText('#panel-guide');
    for (const label of ['Project name', 'What was it about?', 'What did you do?', 'Your role or position', 'Name of the group or place', 'Course or certificate name']) assert.ok(text.includes(label), label);
    await s.page.click('.wiz-dot:has-text("Skills")');
    text = await s.page.innerText('#panel-guide');
    assert.match(text, /Skills can come from anywhere: school, volunteering, hobbies, family responsibilities or a job/); assert.match(text, /Only tick things you could show or explain/);
    await s.close();
  });

  await t.test('the regular editor uses the same plain words (introduction, qualification, expected year) and no jargon', async () => {
    const s = await open({}); await unlockViaWizard(s, 'first'); await s.page.click('.wiz-dot:has-text("School")'); await s.page.click('.wiz-add:has-text("Add a school")');
    await s.page.click('.wiz-dot:has-text("Review")'); await s.page.click('button:has-text("Open in Editor")');
    const text = (await s.page.innerText('#edit-fields')).toLowerCase();                  // labels are upper-cased by the page style
    for (const needle of ['Introduction', 'One-line introduction (shown at the top of your resume)', 'Qualification and subject', 'Year (or “Expected 2027” if still studying)', 'Highlights (optional)', '+ Add School'].map((x) => x.toLowerCase())) assert.ok(text.includes(needle), needle);
    assert.doesNotMatch(text, /tagline|\bhonors\b|\bdegree\b/i); await s.close();
  });

  await t.test('PDF has selectable, extractable text in every one of the 12 templates (no page images), in reading order', async () => {
    const s = await open({});
    await licensedSample(s);
    const ids = await s.page.evaluate(() => TEMPLATES.map((x) => x.id));
    assert.equal(ids.length, 12);
    for (const id of ids) {
      await s.page.evaluate((i) => selectTemplate(i), id);
      const r = pdfText(await download(s, '#btn-pdf', `${id}.pdf`));
      assert.equal(r.images, 0, `${id}: PDF must not contain page images`);
      for (const needle of ['EMMA LARSEN', 'Vice President, Retail Operations', 'Oversaw full-cycle retail operations', 'Drove 28% YoY revenue increase', 'Kellogg School of Management', 'Six Sigma Green Belt', 'emma.larsen@email.com']) {
        assert.ok(r.ops.toUpperCase().includes(needle.toUpperCase()), `${id}: text operators should contain "${needle}"`);
        if (r.poppler !== null) assert.ok(r.poppler.toUpperCase().replace(/\s+/g, ' ').includes(needle.toUpperCase()), `${id}: poppler should extract "${needle}"`);
      }
      if (r.poppler !== null) {                                                // headings must not be spaced out letter by letter
        assert.match(r.poppler, /PROFESSIONAL SUMMARY/i); assert.doesNotMatch(r.poppler, /P\s+R\s+O\s+F\s+E\s+S/);
        const flat = r.poppler.replace(/\s+/g, ' ');
        const pos = ['SUMMARY', 'EXPERIENCE', 'EDUCATION'].map((h) => flat.toUpperCase().indexOf(h));
        if (!['scholar', 'researcher', 'foreman'].includes(id)) assert.ok(pos[0] < pos[1] && pos[1] < pos[2], `${id}: reading order ${pos}`);
      }
    }
    assert.deepEqual(s.errors, []); await s.close();
  });

  await t.test('PDF fixes: desktop and phone viewports give the same pages and full-width text (no clipping, no blank page)', async () => {
    const out = {};
    for (const [label, vp, extra] of [['desktop', { width: 1280, height: 900 }, {}], ['phone', { width: 390, height: 844 }, { isMobile: true, hasTouch: true }]]) {
      const s = await open({}, vp, extra);
      await licensedSample(s);
      const r = pdfText(await download(s, '#btn-pdf', `${label}.pdf`));
      out[label] = r;
      for (const line of ['EMMA LARSEN', 'March 2020 – Present', 'Reduced shrinkage by 22% through inventory audit overhaul and team accountability initiatives'])
        assert.ok(r.ops.includes(line), `${label}: "${line}" must be present whole (not clipped)`);
      const firstPageText = spawnSync('pdftotext', ['-f', '1', '-l', '1', path.join(TMP, `${label}.pdf`), '-'], { encoding: 'utf8' });
      if (!firstPageText.error) assert.ok(firstPageText.stdout.trim().length > 200, `${label}: page 1 must not be blank`);
      await s.close();
    }
    assert.equal(out.desktop.pages, out.phone.pages); assert.equal(out.desktop.ops, out.phone.ops);       // identical regardless of screen size
  });

  await t.test('Word export keeps experience summaries, projects, volunteering and training; per-template styling does not drop content', async () => {
    const s = await open({});
    await licensedSample(s);
    let x = docxText(await download(s, '#btn-word', 'sample.docx'));
    assert.match(x, /Oversaw full-cycle retail operations for 18 flagship stores/);     // the previously dropped experience summary
    assert.match(x, /March 2020 – Present/); assert.match(x, /CERTIFICATIONS & TRAINING/);
    await load(s, FIRST_TIMER, 'studio');
    x = docxText(await download(s, '#btn-word', 'first.docx'));
    for (const needle of ['School food drive', 'Collected canned food for a local pantry', 'Sorted and counted the cans', 'VOLUNTEER & ACTIVITIES', 'Community Food Pantry', '2025 – Present', 'Honor roll', 'Food Handler Course', 'Seeking a customer service position', 'Teamwork – Customer service'])
      assert.ok(x.includes(needle), `Word should contain "${needle}"`);
    assert.doesNotMatch(x, /EXPERIENCE/);
    assert.ok(x.indexOf('EDUCATION') < x.indexOf('PROJECTS'), 'education leads when there is no work history');
    assert.deepEqual(s.errors, []); await s.close();
  });

  await t.test('PDF carries projects, volunteering, education-first order and the right section names for a first resume', async () => {
    const s = await open({});
    await licensedSample(s);
    await load(s, FIRST_TIMER, 'partner');
    const r = pdfText(await download(s, '#btn-pdf', 'first.pdf'));
    for (const needle of ['SCHOOL FOOD DRIVE'.toLowerCase(), 'Sorted and counted the cans', 'Community Food Pantry', '2025 – Present', 'Honor roll', 'Food Handler Course'])
      assert.ok(r.ops.toLowerCase().includes(needle.toLowerCase()), needle);
    assert.ok(r.ops.indexOf('EDUCATION') < r.ops.indexOf('PROJECTS') && r.ops.indexOf('PROJECTS') < r.ops.indexOf('VOLUNTEER'));
    assert.ok(!r.ops.includes('EXPERIENCE')); await s.close();
  });

  await t.test('long content paginates cleanly: nothing lost across pages, no headings stranded at the bottom', async () => {
    const s = await open({});
    await licensedSample(s);
    const long = JSON.parse(JSON.stringify(WORKER));
    long.experience = Array.from({ length: 9 }, (_, i) => ({ title: `Role ${i + 1}`, company: `Fictional Co ${i + 1}`, location: '', start: `${2000 + i}`, end: `${2001 + i}`, summary: '', bullets: Array.from({ length: 5 }, (_, j) => `Task ${i + 1}.${j + 1} ${'with a deliberately long description that must wrap onto more than one line '.repeat(2)}`) }));
    await load(s, long, 'boardroom');
    const f = await download(s, '#btn-pdf', 'long.pdf'); const r = pdfText(f);
    assert.ok(r.pages >= 3, `pages=${r.pages}`);
    for (let i = 1; i <= 9; i++) for (let j = 1; j <= 5; j++) assert.ok(r.ops.includes(`Task ${i}.${j} `), `missing Task ${i}.${j}`);
    const pp = spawnSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' });
    if (!pp.error) pp.stdout.split('\f').forEach((pg, k) => { const lines = pg.split('\n').map((l) => l.trim()).filter(Boolean); if (lines.length) assert.ok(!/^(EXPERIENCE|EDUCATION)$/.test(lines[lines.length - 1]), `page ${k + 1} ends with a stranded heading`); });
    await s.close();
  });

  await t.test('characters the PDF font cannot draw are simplified with a notice; Word keeps them; no crash', async () => {
    const s = await open({});
    await licensedSample(s);
    await load(s, { ...WORKER, name: 'José Łukasz 日本', summary: { tagline: 'Café “manager” – smiley 🙂', bullets: [], skills: [] } }, 'partner');
    await download(s, '#btn-pdf', 'unicode.pdf');
    assert.match(await s.page.innerText('#export-notice'), /simplified/);
    const x = docxText(await download(s, '#btn-word', 'unicode.docx'));
    assert.ok(x.includes('日本') && x.includes('🙂'));
    assert.deepEqual(s.errors, []); await s.close();
  });

  await t.test('HTML typed into the builder is shown literally and never runs, in the preview, PDF and Word', async () => {
    const s = await open({ 'verify-license': verifyOk });
    await unlockViaWizard(s, 'first');
    await s.page.click('.wiz-next');
    await s.page.fill('input[placeholder="e.g. Taylor Rivera"]', 'Riley <img src=x onerror="window.__xss=1"> Park');
    await s.page.click('.wiz-dot:has-text("Projects")');
    await s.page.click('.wiz-add:has-text("Add a project")');
    await s.page.fill('input[placeholder="e.g. School food drive"]', '<script>window.__xss2=1</script>Drive');
    await s.page.fill('textarea[placeholder^="Asked classmates"]', '<iframe srcdoc="<script>parent.__xss3=1</script>"></iframe>');
    await s.page.click('.wiz-dot:has-text("Review")');
    await s.page.waitForTimeout(300);
    assert.deepEqual(await s.page.evaluate(() => Object.keys(window).filter((k) => k.startsWith('__xss'))), []);
    assert.equal(await s.page.evaluate(() => document.querySelectorAll('#resume-preview img, #resume-preview script, #resume-preview iframe, #panel-guide img, #panel-guide iframe').length), 0);
    assert.match((await s.page.innerText('#resume-preview')).toLowerCase(), /<img src=x/);
    assert.ok(pdfText(await download(s, '#btn-pdf', 'xss.pdf')).ops.includes('<script>window.__xss2=1</script>Drive'));
    assert.ok(docxText(await download(s, '#btn-word', 'xss.docx')).includes('<script>window.__xss2=1</script>Drive'));
    await s.close();
  });

  await t.test('phone layout: no horizontal scrolling on the start screen, in the builder, or on the review screen', async () => {
    const s = await open({ 'verify-license': verifyOk }, { width: 390, height: 844 }, { isMobile: true, hasTouch: true });
    const overflow = () => s.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await s.page.fill('#gate-code-input', 'FG-TEST-AAAA'); await s.page.click('#gate-unlock-btn'); await s.page.waitForSelector('#license-gate', { state: 'hidden' });
    assert.ok((await overflow()) <= 1, `start screen overflow ${await overflow()}`);
    await s.page.click('#start-first');
    await s.page.waitForSelector('#panel-guide .wiz-title');
    for (const step of ['Goal', 'You', 'Work', 'School', 'Projects', 'Skills', 'Review']) {
      await s.page.click(`.wiz-dot:has-text("${step}")`);
      if (step === 'Work') await s.page.click('.wiz-choice:has-text("Yes, I’ve had a paid job")').catch(() => {});
      assert.ok((await overflow()) <= 1, `${step}: overflow ${await overflow()}`);
    }
    assert.equal(await s.page.isVisible('.wiz-preview-link'), true);           // phone users can jump to the live preview
    await s.close();
  });

  await t.test('existing paths unchanged: the free sample makes no paid call, exports work, and tailoring flags unverified AI lines with Undo', async () => {
    const okParse = () => ({ status: 200, json: { result: JSON.stringify(WORKER), usesRemaining: 4, maxUses: 5, tailorToken: 'tok-123' } });
    const tailored = JSON.parse(JSON.stringify(WORKER));
    tailored.experience[0].bullets = ['Performed 500 cycle counts per week', 'Loaded and unloaded trucks'];
    const tailorOk = () => ({ status: 200, json: { result: JSON.stringify({ resume: tailored, matchSummary: { matchedKeywords: ['trucks'], missingKeywords: [], notes: 'ok' } }),
      unverified: [{ where: 'experience.0.bullets.0', text: 'Performed 500 cycle counts per week', reasons: ['number not in your resume: 500'] }], tailorRunsRemaining: 4 } });
    const s = await open({ 'verify-license': verifyOk, 'parse-resume': okParse, 'tailor-resume': tailorOk });
    await s.page.fill('#gate-code-input', 'FG-TEST-AAAA'); await s.page.click('#gate-unlock-btn'); await s.page.waitForSelector('#license-gate', { state: 'hidden' });
    await s.page.fill('#resume-input', 'Michael Johnson, warehouse'); await s.page.click('#parse-btn'); await s.page.waitForSelector('#resume-preview');
    assert.match(await s.page.innerText('#license-badge'), /4 of 5/);
    assert.equal(await s.page.isVisible('#export-bar'), true);
    await s.page.fill('#job-desc-input', 'Warehouse associate'); await s.page.click('#tailor-btn');
    await s.page.waitForSelector('#match-summary-box .notice-box');
    assert.match(await s.page.innerText('#match-summary-box'), /Please check 1 line/);
    assert.equal(await s.page.locator('textarea.flag-warn').count(), 1);
    assert.match(await s.page.locator('textarea.flag-warn').inputValue(), /cycle counts/);
    assert.match(await s.page.innerText('#edit-fields'), /Added by AI/);
    await s.page.fill('textarea.flag-warn', 'Counted inventory each week');                    // editing a flagged line clears its flag on the next render
    await s.page.evaluate(() => renderEditFields());
    assert.equal(await s.page.locator('textarea.flag-warn').count(), 0);
    await s.page.click('text=Undo this tailoring');
    assert.deepEqual(await s.page.evaluate(() => state.data.experience[0].bullets), WORKER.experience[0].bullets);
    assert.deepEqual([...new Set(s.calls.map((c) => c.name))].sort(), ['parse-resume', 'tailor-resume', 'verify-license']);
    assert.equal(s.calls.filter((c) => c.name === 'parse-resume').length, 1);                // exactly one paid call; tailoring sent the token, not the code
    assert.equal(s.calls.find((c) => c.name === 'tailor-resume').body.tailorToken, 'tok-123');
    assert.equal(JSON.stringify(s.calls.find((c) => c.name === 'tailor-resume').body).includes('FG-TEST'), false);
    await s.close();
  });

  await t.test('the page loads no third-party scripts (the old CDN dependency is gone) and talks only to its own endpoints', async () => {
    const s = await open({});
    await s.page.click('.gate-sample-link');
    for (const u of s.external) assert.ok(/fonts\.(googleapis|gstatic)\.com/.test(u), `unexpected external host: ${u}`);
    assert.equal(await s.page.evaluate(() => [...document.scripts].filter((x) => x.src && !x.src.startsWith(location.origin)).length), 0);
    await s.close();
  });

  await browser.close(); server.close();
});
