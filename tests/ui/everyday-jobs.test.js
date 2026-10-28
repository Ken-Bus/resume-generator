// Everyday jobs: ordinary workers can find a suitable template, the free sample looks like their kind of resume, and a first resume with no work
// history is never forced into a work-history section. Real index.html in headless Chromium; every endpoint is blocked or mocked, nothing is paid.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { PW, CHROME, unavailable } = require('./browser');
const Templates = require(path.join(ROOT, 'templates.js'));
const Core = require(path.join(ROOT, 'resume-core.js'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const FIRST = { name: 'Taylor Morgan', contact: { phone: '(555) 010-0142', email: 'taylor.morgan@example.com', location: 'Dayton, OH', linkedin: '', website: '' },
  summary: { tagline: 'Seeking an entry-level Customer Service Associate position', bullets: [], skills: ['Customer service', 'Teamwork'] }, experience: [],
  education: [{ degree: 'High School Diploma', school: 'Oakwood High School', location: 'Dayton, OH', date: '2026', honors: '' }],
  certifications: [{ name: 'Food Handler Card', org: '', date: '2026' }],
  projects: [{ name: 'School food drive', description: 'Collected canned food for a local pantry', bullets: ['Sorted and counted the donations'] }],
  volunteer: [{ title: 'Volunteer', organization: 'Community Pantry', location: '', start: '2025', end: 'Present', bullets: ['Packed grocery boxes'] }], awards: [] };

test('everyday jobs: template labels, recommendations and sections (no work history needed)', async (t) => {
  await t.test('every template says who it is good for, in plain words, and every tab has an on-screen name', () => {
    assert.equal(Templates.TEMPLATES.length, 12); assert.equal(Templates.CATEGORIES.length, 6);
    for (const tpl of Templates.TEMPLATES) {
      assert.ok(typeof tpl.bestFor === 'string' && tpl.bestFor.length >= 40 && tpl.bestFor.length <= 120, `${tpl.id}: bestFor length`);
      assert.doesNotMatch(tpl.bestFor, /ATS|guarantee|interview|hired|best|#1/i, `${tpl.id}: no promises or superlatives`);
    }
    for (const c of Templates.CATEGORIES) assert.ok(Templates.CATEGORY_LABELS[c], `label for ${c}`);
    assert.equal(Templates.CATEGORY_LABELS.Trades, 'Labor & Trades');
    const everyday = ['retail', 'warehouse', 'food service', 'delivery', 'construction', 'maintenance', 'manufacturing', 'housekeeping', 'customer service', 'office', 'first jobs'];
    const text = Templates.TEMPLATES.map((x) => x.bestFor.toLowerCase()).join(' ');
    for (const w of everyday) assert.ok(text.includes(w), `an existing template is recommended for: ${w}`);
  });

  await t.test('a first resume with no work history gets no Experience section, in any of the 12 templates; education leads', () => {
    for (const tpl of Templates.TEMPLATES) {
      const keys = Core.sections(Core.clean(FIRST), tpl).map((s) => s.key);
      assert.ok(!keys.includes('experience'), `${tpl.id}: no experience section`);
      assert.deepEqual(keys.filter((k) => k !== 'summary' && k !== 'skills').slice(0, 1), [tpl.id === 'foreman' ? 'certifications' : 'education'], `${tpl.id}: what leads`);
    }
  });

  if (unavailable(t)) return;
  const { chromium } = require(PW);
  const server = await new Promise((r) => { const sv = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f)); }); sv.listen(0, '127.0.0.1', () => r(sv)); });
  const base = `http://127.0.0.1:${server.address().port}`; const browser = await chromium.launch({ executablePath: CHROME });
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage(); const calls = []; const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route('**/*', (route) => { const u = route.request().url(); if (u.includes('/.netlify/functions/')) { calls.push(u.split('/.netlify/functions/')[1]); return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"blocked in test"}' }); } return u.startsWith(base) ? route.continue() : route.abort(); });
    await page.goto(base); await page.waitForSelector('.gate-sample-link'); return { page, calls, errors, close: () => ctx.close() };
  };

  await t.test('the tabs use everyday names, and choosing a template explains what it is good for', async () => {
    const s = await open(); await s.page.click('.gate-sample-link'); await s.page.waitForSelector('#resume-preview');
    const tabs = (await s.page.locator('.category-tab').allInnerTexts()).map((x) => x.trim().toLowerCase());
    assert.deepEqual(tabs, ['office & business', 'tech', 'creative', 'care & service', 'academic', 'labor & trades']);
    await s.page.click('.category-tab:has-text("Labor & Trades")');
    assert.match(await s.page.innerText('#template-note'), /The Operator is good for: Retail, warehouse, food service, delivery and first jobs/);
    await s.page.click('.variant-btn:has-text("The Foreman")');
    assert.match(await s.page.innerText('#template-note'), /The Foreman is good for: Construction, maintenance, manufacturing and housekeeping/);
    for (const tpl of Templates.TEMPLATES) {
      await s.page.evaluate((id) => { selectCategory(TEMPLATES.find((x) => x.id === id).category); selectTemplate(id); }, tpl.id);
      const note = await s.page.innerText('#template-note'); assert.ok(note.includes(tpl.name) && note.includes(tpl.bestFor.slice(0, 20)), tpl.id);
    }
    assert.deepEqual(s.errors, []); await s.close();
  });

  await t.test('"Try Sample" is an everyday-job resume, "Office Sample" keeps the executive one, and neither calls the AI', async () => {
    const s = await open(); await s.page.click('.gate-sample-link'); await s.page.waitForSelector('#resume-preview');
    const prev = await s.page.innerText('#resume-preview');
    assert.match(prev, /Maria Delgado/i); assert.match(prev, /Warehouse Associate/i); assert.match(prev, /Forklift Operator Certification/i); assert.doesNotMatch(prev, /\$\d|Vice President|\d+%/);
    assert.match(await s.page.inputValue('#resume-input'), /Maria Delgado/);
    await s.page.evaluate(() => switchPanel('paste')); await s.page.click('#office-sample-btn'); assert.match(await s.page.innerText('#resume-preview'), /Emma Larsen/i);
    await s.page.evaluate(() => loadSample()); assert.match(await s.page.innerText('#resume-preview'), /Maria Delgado/i);
    assert.deepEqual(s.calls.filter((c) => /parse-resume|polish-resume|tailor-resume/.test(c)), []); await s.close();
  });

  await t.test('the everyday sample and a first resume stay single-column, plain text, in every template (no tables, no columns, no images)', async () => {
    const s = await open(); await s.page.click('.gate-sample-link'); await s.page.waitForSelector('#resume-preview');
    for (const [label, data] of [['sample', null], ['first resume', FIRST]]) {
      if (data) await s.page.evaluate((d) => { state.data = JSON.parse(JSON.stringify(d)); state.sampleJson = null; renderEditFields(); }, data);
      for (const tpl of Templates.TEMPLATES) {
        await s.page.evaluate((id) => { selectCategory(TEMPLATES.find((x) => x.id === id).category); selectTemplate(id); }, tpl.id);
        const r = await s.page.evaluate(() => { const p = document.getElementById('resume-preview'); const cs = getComputedStyle(p);
          return { tables: p.querySelectorAll('table').length, imgs: p.querySelectorAll('img').length, columns: cs.columnCount,
            hasExperience: /\bEXPERIENCE\b/i.test(p.innerText), text: p.innerText }; });
        assert.equal(r.tables, 0, `${label}/${tpl.id}`); assert.equal(r.imgs, 0, `${label}/${tpl.id}`); assert.ok(r.columns === 'auto' || r.columns === '1', `${label}/${tpl.id}: columns ${r.columns}`);
        if (data) assert.equal(r.hasExperience, false, `${tpl.id}: a first resume shows no Experience heading`);
      }
    }
    assert.deepEqual(s.errors, []); await s.close();
  });

  await browser.close(); server.close();
});
