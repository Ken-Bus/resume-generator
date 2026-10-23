// Browser replay of the live acceptance result (fictional Taylor Rivera): the real page, the real integrity guard on the AI's exact answer,
// then the real page applying the server's reply. Only the network is faked, and the "server" is the real guard code. No AI, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const integrity = require('../../netlify/functions/_lib/integrity');
const Core = require('../../resume-core.js');
const clone = (o) => JSON.parse(JSON.stringify(o));

const TAYLOR = { name: 'Taylor Rivera', contact: { email: 'taylor.rivera@example.com', location: 'Dayton, OH', phone: '', linkedin: '', website: '' },
  summary: { tagline: 'Seeking a customer service position', bullets: [], skills: ['Teamwork'] }, experience: [],
  education: [{ degree: 'High School Diploma', school: 'Oakwood High School', location: '', date: '2026', honors: '' }], certifications: [],
  projects: [{ name: 'School Food Drive', description: '', bullets: ['Asked classmates to donate canned food.', 'Sorted and counted donated items.', 'Helped organize food for pickup.'] }],
  volunteer: [{ title: 'Volunteer', organization: 'Community Food Pantry', location: '', start: '2025', end: 'Present', bullets: ['Packed grocery boxes on Saturdays', 'Greeted families as they arrived'] }], awards: [] };
const LIVE = (r) => { const o = clone(r); const p = o.projects[0];
  p.description = 'Helped collect donated food for families in the community.';
  p.bullets = ['Asked classmates to donate canned food for families in the community.', 'Sorted and counted donated items.', 'Helped organize donated food for pickup.']; return o; };

function serve() {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

test('live replay in the browser: the invented "families in the community" never reaches the screen, the editor or the download data', async (t) => {
  if (!fs.existsSync(PW) || !fs.existsSync(CHROME)) { t.skip('Playwright/Chromium not available'); return; }
  const { chromium } = require(PW);
  const server = await serve(); const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(async () => { await browser.close(); server.close(); });

  for (const layout of [{ name: 'desktop', viewport: { width: 1280, height: 900 } }, { name: 'android', viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true }]) {
    await t.test(`[${layout.name}] polish with the live AI answer`, async () => {
      const { name, ...ctxOpts } = layout;
      const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage(); const errors = []; let sent = null;
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.includes('/.netlify/functions/polish-resume')) {
          sent = JSON.parse(route.request().postData());
          // The same steps polish-resume runs on the AI's answer: clean the customer's resume, guard the AI's reply, report what changed.
          const source = Core.clean(sent.resume);
          const g = integrity.guardResume(source, LIVE(source), { mode: 'polish', vocabulary: sent.target });
          const changes = integrity.assessChange(source, g.resume);
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ guard: { version: Core.GUARD_VERSION, withholds: true }, result: JSON.stringify(g.resume), unverified: [], withheld: g.withheld, changes, charged: true, usesRemaining: 4, maxUses: 5, tailorToken: 'tok' }) });
        }
        if (url.includes('/.netlify/functions/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, usesRemaining: 5, maxUses: 5 }) });
        if (url.startsWith(base)) return route.continue();
        return route.abort();
      });
      await page.goto(base + '/index.html');
      await page.fill('#gate-code-input', 'FG-TEST-AAAA'); await page.click('#gate-unlock-btn'); await page.waitForSelector('#license-gate', { state: 'hidden' });
      await page.click('#start-first'); await page.waitForSelector('#panel-guide .wiz-title');
      await page.evaluate((d) => { state.data = JSON.parse(JSON.stringify(d)); state.data.projects.push({ name: '', description: '', bullets: [''] }); Wiz.render(); renderPreview(); }, TAYLOR);   // the page keeps blank rows
      await page.click('.wiz-dot:has-text("Review")');
      await page.click('#polish-btn'); await page.click('#polish-confirm');
      await page.waitForFunction(() => !state.polish.busy); await page.waitForTimeout(150);

      assert.equal(sent.resume.projects[0].description, '', 'the page really sent the blank description');
      const d = await page.evaluate(() => state.data.projects.find((p) => /food drive/i.test(p.name)));
      assert.equal(d.description, '', 'description stays blank in the page data');
      assert.equal(d.bullets[0], 'Asked classmates to donate canned food.');
      assert.equal(d.bullets[2], 'Helped organize donated food for pickup.', 'the honest reword is applied');
      const preview = await page.innerText('#resume-preview');
      assert.doesNotMatch(preview, /for families in the community|collect donated food/i);
      assert.match(preview, /Greeted families as they arrived/, 'the volunteer line that really says it is untouched');
      const card = await page.innerText('.wiz-ok');
      assert.match(card, /left out/i); assert.match(card, /School Food Drive, description/); assert.doesNotMatch(card, /for families in the community/i, 'the AI\'s rejected text is not shown');
      await page.click('button:has-text("Open in Editor")'); await page.waitForSelector('#edit-fields');
      const fields = await page.locator('#edit-fields textarea, #edit-fields input').evaluateAll((els) => els.map((e) => e.value).join('\n'));
      assert.doesNotMatch(fields, /for families in the community|collect donated food/i, 'nor in any editor field');
      assert.equal(await page.locator('#edit-fields textarea.flag-warn').count(), 0, 'no yellow "kept with a warning" lines: they are withheld, not kept');
      assert.equal(await page.evaluate(() => ResumeCore.GUARD_VERSION), 'entry-scope-withhold-3', 'the page carries the same guard version as the functions');
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  }
});
