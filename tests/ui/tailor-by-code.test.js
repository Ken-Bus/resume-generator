// The customer page with tailoring authorised by the access code (migration 06). Endpoints are mocked; nothing leaves the machine.
// Existing UI suites (ui, release-hardening, drafts, work-safety...) keep covering the token path and everything unrelated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { PW, CHROME, unavailable } = require('./browser');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const serve = () => new Promise((r) => { const server = http.createServer((req, res) => {
  const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
}); server.listen(0, '127.0.0.1', () => r(server)); });

const RESUME = { name: 'Jordan Ellis', contact: { email: 'jordan.ellis@example.com' }, summary: { tagline: '', bullets: [], skills: ['Customer service'] },
  experience: [{ title: 'Retail Associate', company: 'Fictional Maple Market', start: 'June 2023', end: 'August 2026', bullets: ['Assisted customers'] }], education: [], certifications: [], projects: [], awards: [] };
const TAILORED = { resume: RESUME, matchSummary: { matchedKeywords: ['customer service'], missingKeywords: [], notes: 'ok' } };

test('tailoring by access code on the customer page (Chromium, mocked endpoints)', async (t) => {
  if (unavailable(t)) return;
  const { chromium } = require(PW);
  const server = await serve(); const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME });
  async function open(api) {
    const ctx = await browser.newContext(); const page = await ctx.newPage(); const calls = [];
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.includes('/.netlify/functions/')) {
        const name = url.split('/.netlify/functions/')[1]; let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (e) {}
        calls.push({ name, body });
        const r = await (api[name] || (() => ({ status: 500, json: { error: 'unmocked' } })))(body, calls.filter((c) => c.name === name).length);
        if (r.raw) return route.fulfill({ status: r.status, headers: r.headers, body: r.body });
        return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.json) });
      }
      return url.startsWith(base) ? route.continue() : route.abort();
    });
    await page.goto(base + '/index.html');
    return { page, calls, close: () => ctx.close() };
  }
  const verify = (extra = {}) => () => ({ status: 200, json: { valid: true, usesRemaining: 4, maxUses: 5, includedAvailable: 1, accessState: 'active', accessUntil: null, ...extra } });
  // A resume that arrived WITHOUT a tailoring token: a new tab, a new day, or a draft restored after a break.
  const parseNoToken = () => ({ status: 200, json: { result: JSON.stringify(RESUME), usesRemaining: 4, maxUses: 5, tailorToken: null } });
  async function ready(s) {
    await s.page.fill('#gate-code-input', 'FG-TEST-AAAA'); await s.page.click('#gate-unlock-btn'); await s.page.waitForSelector('#license-gate', { state: 'hidden' });
    await s.page.fill('#resume-input', 'Jordan Ellis — Retail Associate'); await s.page.click('#parse-btn'); await s.page.waitForSelector('#resume-preview');
    await s.page.fill('#job-desc-input', 'Administrative assistant');
  }

  await t.test('with NO tailoring token the page still tailors: it sends the access code, and shows the runs left from sign-in and from each run', async () => {
    const s = await open({ 'verify-license': verify({ tailorRunsAvailable: 3 }), 'parse-resume': parseNoToken,
      'tailor-resume': () => ({ status: 200, json: { result: JSON.stringify(TAILORED), unverified: [], withheld: [], tailorRunsRemaining: 2, tailorRunsAvailable: 2 } }) });
    await ready(s);
    assert.equal(await s.page.evaluate(() => state.tailorToken), null);
    await s.page.waitForFunction(() => /\d+ tailoring run/.test(document.getElementById('tailor-runs-note').textContent));
    await s.page.click('#tailor-btn'); await s.page.waitForSelector('#match-summary-box .btn-secondary');
    const call = s.calls.find((c) => c.name === 'tailor-resume'); assert.equal(call.body.code, 'FG-TEST-AAAA'); assert.ok(!call.body.tailorToken);
    assert.equal(await s.page.innerText('#tailor-runs-note'), '2 tailoring runs left');
    await s.close();
  });

  await t.test('all runs used: the page says so and makes NO tailoring request', async () => {
    const s = await open({ 'verify-license': verify({ tailorRunsAvailable: 0 }), 'parse-resume': parseNoToken });
    await ready(s); assert.equal(await s.page.innerText('#tailor-runs-note'), 'You have used all your tailoring runs.');
    await s.page.click('#tailor-btn'); await s.page.waitForSelector('#match-summary-box', { state: 'visible' });
    assert.match(await s.page.innerText('#match-summary-box'), /used all your tailoring runs/); assert.equal(s.calls.filter((c) => c.name === 'tailor-resume').length, 0);
    await s.close();
  });

  await t.test('an older server that does not report the count: nothing is shown, nothing is blocked', async () => {
    const s = await open({ 'verify-license': verify(), 'parse-resume': parseNoToken,
      'tailor-resume': () => ({ status: 200, json: { result: JSON.stringify(TAILORED), unverified: [], withheld: [], tailorRunsRemaining: 4 } }) });
    await ready(s); assert.equal(await s.page.innerText('#tailor-runs-note'), '');
    await s.page.click('#tailor-btn'); await s.page.waitForSelector('#match-summary-box .btn-secondary'); assert.equal(s.calls.filter((c) => c.name === 'tailor-resume').length, 1);
    await s.close();
  });

  await t.test('access has ended: the server refuses, the page shows its message and re-checks the code (no AI, nothing used)', async () => {
    let ended = false;
    const s = await open({ 'verify-license': () => (ended ? { status: 200, json: { valid: false, accessState: 'ended', error: 'The four-day finishing period for this code has ended.' } } : verify({ tailorRunsAvailable: 2 })()),
      'parse-resume': parseNoToken,
      'tailor-resume': () => { ended = true; return { status: 403, raw: true, headers: { 'Content-Type': 'application/json', 'X-Access-State': 'ended' }, body: JSON.stringify({ error: 'The four-day finishing period for this code has ended, so tailoring is no longer available.' }) }; } });
    await ready(s); await s.page.click('#tailor-btn');
    await s.page.waitForSelector('#license-gate', { state: 'visible' });
    assert.match(await s.page.innerText('#license-gate'), /finishing period/);
    await s.close();
  });

  t.after(async () => { await browser.close(); server.close(); });
});
