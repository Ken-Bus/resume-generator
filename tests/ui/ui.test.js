// Browser tests for the customer-facing page. Endpoints are mocked; nothing leaves the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { PW, CHROME, unavailable } = require('./browser');

const { exportApi } = require('./export-api');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
function serve() {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const RESUME = { name: 'Jordan Ellis', contact: { email: 'jordan.ellis@example.com' }, summary: { tagline: '', bullets: [], skills: ['Customer service', 'P&L'] },
  experience: [{ title: 'Retail Associate', company: 'Fictional Maple Market', start: 'June 2023', end: 'August 2026', bullets: ['Assisted customers'] }], education: [], certifications: [], projects: [], awards: [] };

test('customer page (Chromium, mocked endpoints)', async (t) => {
  if (unavailable(t)) return;
  const { chromium } = require(PW);
  const server = await serve(); const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME });

  // Each scenario gets a fresh page; `api` scripts the mocked endpoints and records every call.
  async function open(api = {}) {
    const ctx = await browser.newContext({ acceptDownloads: true }); const page = await ctx.newPage();
    const calls = []; const external = [];
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.includes('/.netlify/functions/')) {
        const name = url.split('/.netlify/functions/')[1];
        let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (e) {}
        if (name !== 'recover-result') calls.push({ name, body });
        const handler = api[name] || (() => ({ status: 500, json: { error: 'unmocked' } }));
        const r = await handler(body, calls.filter(c => c.name === name).length);
        if (r.delay) await new Promise(x => setTimeout(x, r.delay));
        if (r.raw) return route.fulfill({ status: r.status, headers: r.headers, body: Buffer.from(r.body || '', r.isBase64Encoded ? 'base64' : 'utf8') });
        return route.fulfill(r.html ? { status: r.status, contentType: 'text/html', body: r.html } : { status: r.status, contentType: 'application/json', body: JSON.stringify(r.json) });
      }
      if (url.startsWith(base)) return route.continue();
      external.push(url); return route.abort();
    });
    await page.goto(base + '/index.html');
    return { page, calls, external, close: () => ctx.close() };
  }
  const verifyOk = () => ({ status: 200, json: { valid: true, usesRemaining: 5, maxUses: 5 } });
  async function unlock(page) { await page.fill('#gate-code-input', 'FG-TEST-AAAA'); await page.click('#gate-unlock-btn'); await page.waitForSelector('#license-gate', { state: 'hidden' }); }
  const paste = async (page, txt = 'Jordan Ellis — Retail Associate') => { await page.fill('#resume-input', txt); };
  const okParse = (extra = {}) => () => ({ status: 200, json: { result: JSON.stringify(RESUME), usesRemaining: 4, maxUses: 5, tailorToken: 'tok-123', ...extra } });

  await t.test('"Try Sample" makes NO request to any paid endpoint and still shows the sample', async () => {
    const s = await open({}); await s.page.click('.gate-sample-link');
    await s.page.waitForSelector('#resume-preview');
    assert.match(await s.page.innerText('#resume-preview'), /MARIA DELGADO/i);          // the default sample is an everyday-job resume
    assert.match(await s.page.innerText('#resume-preview'), /Forklift Operator Certification/i);
    await s.page.evaluate(() => loadSample('office'));                                  // the office sample is still there
    assert.match(await s.page.innerText('#resume-preview'), /EMMA LARSEN/i);
    assert.match(await s.page.innerText('#resume-preview'), /P&L Ownership/);        // ampersand survives escaping
    assert.equal(s.calls.length, 0);
    assert.equal(await s.page.isVisible('#export-bar'), true);
    await s.close();
  });

  await t.test('Analyze sends the code to parse-resume once, never calls consume-generation, and updates the counter', async () => {
    const s = await open({ 'verify-license': verifyOk, 'parse-resume': okParse() });
    await unlock(s.page); await paste(s.page); await s.page.click('#parse-btn');
    await s.page.waitForSelector('#resume-preview');
    const parses = s.calls.filter(c => c.name === 'parse-resume');
    assert.equal(parses.length, 1); assert.equal(parses[0].body.code, 'FG-TEST-AAAA'); assert.ok(parses[0].body.resumeText);
    assert.equal(s.calls.filter(c => c.name === 'consume-generation').length, 0);
    assert.match(await s.page.innerText('#license-badge'), /4 of 5/);
    assert.match(await s.page.innerText('#resume-preview'), /JORDAN ELLIS/i);
    await s.close();
  });

  await t.test('double-clicking Analyze sends one request', async () => {
    const s = await open({ 'verify-license': verifyOk, 'parse-resume': () => ({ ...okParse()(), delay: 400 }) });
    await unlock(s.page); await paste(s.page);
    await s.page.evaluate(() => { document.getElementById('parse-btn').click(); document.getElementById('parse-btn').click(); parseResume(); });
    await s.page.waitForSelector('#resume-preview');
    assert.equal(s.calls.filter(c => c.name === 'parse-resume').length, 1);
    await s.close();
  });

  await t.test('failed analysis: readable "not charged" message, nothing rendered, counter re-read from the server', async () => {
    const s = await open({ 'verify-license': verifyOk, 'parse-resume': () => ({ status: 502, json: { error: 'We couldn’t analyze this resume right now. You haven’t been charged. Please try again.' } }) });
    await unlock(s.page); await paste(s.page); await s.page.click('#parse-btn');
    await s.page.waitForSelector('#error-box', { state: 'visible' });
    assert.match(await s.page.innerText('#error-box'), /haven’t been charged/);
    assert.equal(await s.page.locator('#resume-preview').count(), 0);
    assert.match(await s.page.innerText('#license-badge'), /5 of 5/);
    assert.ok(s.calls.filter(c => c.name === 'verify-license').length >= 2);                 // initial unlock + refresh after failure
    await s.close();
  });

  await t.test('gateway HTML error (platform timeout) is handled without a crash and the button recovers', async () => {
    const s = await open({ 'verify-license': verifyOk, 'parse-resume': () => ({ status: 502, html: '<html>Bad Gateway</html>' }) });
    await unlock(s.page); await paste(s.page); await s.page.click('#parse-btn');
    await s.page.waitForSelector('#error-box', { state: 'visible' });
    assert.equal(await s.page.isDisabled('#parse-btn'), false);
    await s.close();
  });

  await t.test('exhausted code shows the Etsy link; a rejected code returns to the gate', async () => {
    let s = await open({ 'verify-license': verifyOk, 'parse-resume': () => ({ status: 403, json: { error: 'x', usesRemaining: 0, maxUses: 5 } }) });
    await unlock(s.page); await paste(s.page); await s.page.click('#parse-btn');
    await s.page.waitForSelector('#error-box a');
    assert.match(await s.page.innerText('#error-box'), /used all 5 generations/); await s.close();
    s = await open({ 'verify-license': verifyOk, 'parse-resume': () => ({ status: 401, json: { error: 'Please refresh the page and enter your access code again.' } }) });
    await unlock(s.page); await paste(s.page); await s.page.click('#parse-btn');
    await s.page.waitForSelector('#license-gate', { state: 'visible' }); await s.close();
  });

  await t.test('a throttled code shows the friendly wait message and the real counter; no crash, no charge', async () => {
    const s = await open({ 'verify-license': verifyOk, 'parse-resume': () => ({ status: 429, json: { error: 'We’ve had several unsuccessful attempts on this code in a short time. To protect your account, please wait about 4 minutes and try again. You haven’t been charged.', retryAfterSeconds: 230, usesRemaining: 5, maxUses: 5 } }) });
    await unlock(s.page); await paste(s.page); await s.page.click('#parse-btn');
    await s.page.waitForSelector('#error-box', { state: 'visible' });
    assert.match(await s.page.innerText('#error-box'), /wait about 4 minutes/);
    assert.match(await s.page.innerText('#license-badge'), /5 of 5/);
    assert.equal(await s.page.isDisabled('#parse-btn'), false);
    await s.close();
  });

  await t.test('over-long resume is stopped in the browser with a clear message (no silent truncation, no request)', async () => {
    const s = await open({ 'verify-license': verifyOk, 'parse-resume': okParse() });
    await unlock(s.page); await s.page.fill('#resume-input', 'x'.repeat(30001)); await s.page.click('#parse-btn');
    assert.match(await s.page.innerText('#error-box'), /too long/);
    assert.equal(s.calls.filter(c => c.name === 'parse-resume').length, 0);
    await s.close();
  });

  await t.test('tailoring: no token on the sample (no request); with a paid generation the signed token is sent; a 401 clears it', async () => {
    let s = await open({}); await s.page.click('.gate-sample-link'); await s.page.waitForSelector('#resume-preview');
    await s.page.fill('#job-desc-input', 'Administrative assistant'); await s.page.click('#tailor-btn');
    assert.equal(await s.page.isVisible('#match-summary-box'), true);                            // the message is actually visible to the customer
    assert.match(await s.page.innerText('#match-summary-box'), /Analyze your resume with your access code first/);
    assert.equal(s.calls.filter(c => c.name === 'tailor-resume').length, 0); await s.close();

    const tailorOk = () => ({ status: 200, json: { result: JSON.stringify({ resume: RESUME, matchSummary: { matchedKeywords: ['a'], missingKeywords: ['<img src=x onerror="window.__x=1">'], notes: 'n' } }) } });
    s = await open({ 'verify-license': verifyOk, 'parse-resume': okParse(), 'tailor-resume': tailorOk });
    await unlock(s.page); await paste(s.page); await s.page.click('#parse-btn'); await s.page.waitForSelector('#resume-preview');
    await s.page.click('button.panel-tab:has-text("Edit Fields")').catch(() => {});
    await s.page.fill('#job-desc-input', 'Administrative assistant'); await s.page.click('#tailor-btn');
    await s.page.waitForSelector('#match-summary-box', { state: 'visible' });
    assert.equal(s.calls.find(c => c.name === 'tailor-resume').body.tailorToken, 'tok-123');
    assert.equal(await s.page.evaluate(() => window.__x), undefined);                          // match-summary text is escaped
    await s.close();

    s = await open({ 'verify-license': verifyOk, 'parse-resume': okParse(), 'tailor-resume': () => ({ status: 401, json: { error: 'Your tailoring session has expired. Analyze your resume again to continue.' } }) });
    await unlock(s.page); await paste(s.page); await s.page.click('#parse-btn'); await s.page.waitForSelector('#resume-preview');
    await s.page.fill('#job-desc-input', 'job'); await s.page.click('#tailor-btn');
    await s.page.waitForSelector('#match-summary-box', { state: 'visible' });
    assert.match(await s.page.innerText('#match-summary-box'), /expired/);
    assert.equal(await s.page.evaluate(() => state.tailorToken), null); await s.close();
  });

  await t.test('F-06: HTML in resume text is shown literally in the preview and never executes', async () => {
    const evil = { ...RESUME, name: 'Riley <img src=x onerror="window.__xss=1"> Park',
      summary: { tagline: '<script>window.__xss2=1</script>tag', bullets: ['<b>bold?</b> & <i>x</i> 100% R&D'], skills: ['"quoted" \'single\''] },
      experience: [{ title: '<svg onload="window.__xss3=1">', company: 'A&B <Co>', start: '2020', end: '<u>2024</u>', summary: '<a href="javascript:window.__xss4=1">s</a>', bullets: ['<iframe srcdoc="<script>parent.__xss5=1</script>"></iframe>'] }],
      education: [{ degree: '<img src=y onerror="window.__xss6=1">', school: 's', date: '1', honors: '<b>h</b>' }],
      certifications: [{ name: '<script>window.__xss7=1</script>', org: '<b>o</b>', date: '2' }], awards: ['<img src=z onerror="window.__xss8=1">'] };
    const s = await open({ 'verify-license': verifyOk, 'parse-resume': () => ({ status: 200, json: { result: JSON.stringify(evil), usesRemaining: 4, maxUses: 5, tailorToken: 't' } }) });
    await unlock(s.page); await paste(s.page); await s.page.click('#parse-btn'); await s.page.waitForSelector('#resume-preview');
    await s.page.waitForTimeout(400);
    for (const tmpl of ['boardroom', 'editorial', 'foreman', 'scholar']) {
      await s.page.evaluate((id) => selectTemplate(id), tmpl);
      const injected = await s.page.evaluate(() => ({
        flags: Object.keys(window).filter(k => k.startsWith('__xss')),
        elements: document.querySelectorAll('#resume-preview img, #resume-preview script, #resume-preview svg[onload], #resume-preview iframe, #resume-preview a, #resume-preview b, #resume-preview i, #resume-preview u').length }));
      assert.deepEqual(injected.flags, [], tmpl); assert.equal(injected.elements, 0, tmpl);
    }
    const txt = (await s.page.innerText('#resume-preview')).toLowerCase();      // the name is upper-cased by CSS
    for (const lit of ['<img src=x', '<script>', '<b>bold?</b>', 'A&B <Co>', '100% R&D', '"quoted"', "'single'", '<svg onload']) assert.ok(txt.includes(lit.toLowerCase()), `expected literal text: ${lit}`);
    await s.close();
  });

  await t.test('Word export still works (now through the licensed export function)', async () => {
    const s = await open({ 'verify-license': verifyOk, 'parse-resume': okParse(), 'export-resume': exportApi(['FG-TEST-AAAA']) });
    await unlock(s.page); await paste(s.page); await s.page.click('#parse-btn'); await s.page.waitForSelector('#resume-preview');
    const [dl] = await Promise.all([s.page.waitForEvent('download', { timeout: 20000 }), s.page.click('#btn-word')]);
    assert.match(dl.suggestedFilename(), /\.docx$/);
    await s.close();
  });

  await t.test('the page only talks to its own Netlify endpoints (no direct database access, no other hosts used by app code)', async () => {
    const s = await open({ 'verify-license': verifyOk, 'parse-resume': okParse() });
    await unlock(s.page); await paste(s.page); await s.page.click('#parse-btn'); await s.page.waitForSelector('#resume-preview');
    const names = new Set(s.calls.map(c => c.name));
    for (const n of names) assert.ok(['verify-license', 'parse-resume', 'tailor-resume', 'export-resume'].includes(n), n);
    for (const u of s.external) assert.ok(/fonts\.(googleapis|gstatic)\.com/.test(u), `unexpected external host: ${u}`);
    await s.close();
  });

  await browser.close(); server.close();
});
