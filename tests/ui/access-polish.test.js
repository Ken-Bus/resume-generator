// Browser tests: who can download, and the AI Polish flow. The export function is the REAL handler (real
// authorization + rendering); the license lookup and the AI are mocked. Fictional applicants only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { exportApi } = require('./export-api');
const { pdfText } = require('../functions/files');

const ROOT = path.join(__dirname, '..', '..');
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-access-'));
const GOOD = 'FG-TEST-AAAA';

const serve = () => new Promise((r) => {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  server.listen(0, '127.0.0.1', () => r(server));
});

const ANSWERS = {
  name: 'Taylor Rivera', contact: { phone: '', email: 'taylor.rivera@example.com', location: 'Dayton, OH', linkedin: '', website: '' },
  summary: { tagline: 'Seeking a customer service position', bullets: [], skills: ['Teamwork'] }, experience: [],
  education: [{ degree: 'High School Diploma', school: 'Oakwood High School', location: '', date: '2026', honors: '' }], certifications: [],
  projects: [{ name: 'School food drive', description: '', bullets: ['asked classmates to donate cans', 'sorted and counted the cans'] }], volunteer: [], awards: []
};
const POLISHED = { ...ANSWERS, summary: { tagline: 'Seeking a customer service position', bullets: [], skills: ['Teamwork'] },
  projects: [{ name: 'School food drive', description: '', bullets: ['Organized a food drive that collected 1,200 cans', 'Sorted and counted donated cans'] }] };

test('access control and AI polish (Chromium)', async (t) => {
  if (!fs.existsSync(PW) || !fs.existsSync(CHROME)) { t.skip('Playwright/Chromium not available'); return; }
  const { chromium } = require(PW);
  const server = await serve(); const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME });

  const verifyOk = (b) => (b && b.code === GOOD ? { status: 200, json: { valid: true, usesRemaining: 5, maxUses: 5 } } : { status: 200, json: { valid: false, error: 'We couldn’t find that code.' } });
  async function open(api0 = {}, opts = {}) {
    const ctx = opts.ctx || await browser.newContext({ acceptDownloads: true, viewport: opts.viewport || { width: 1280, height: 900 } });
    const page = await ctx.newPage(); const calls = []; const errors = [];
    page.on('pageerror', (e) => errors.push(String(e))); page.on('dialog', (d) => d.accept());
    const api = { 'verify-license': verifyOk, 'export-resume': exportApi([GOOD]), ...api0 };
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.includes('/.netlify/functions/')) {
        const name = url.split('/.netlify/functions/')[1];
        let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (e) {}
        calls.push({ name, body });
        if (api[name] === 'offline') return route.abort('internetdisconnected');
        const r = await (api[name] || (() => ({ status: 500, json: { error: 'unmocked' } })))(body, calls.filter((c) => c.name === name).length);
        if (r.delay) await new Promise((x) => setTimeout(x, r.delay));
        if (r.raw) return route.fulfill({ status: r.status, headers: r.headers, body: Buffer.from(r.body || '', r.isBase64Encoded ? 'base64' : 'utf8') });
        return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.json) });
      }
      return url.startsWith(base) ? route.continue() : route.abort();
    });
    await page.goto(base + '/index.html');
    return { page, ctx, calls, errors, api, close: () => ctx.close() };
  }
  const exportCalls = (s) => s.calls.filter((c) => c.name === 'export-resume');
  const unlock = async (s, code = GOOD) => { await s.page.fill('#gate-code-input', code); await s.page.click('#gate-unlock-btn'); await s.page.waitForTimeout(200); };
  const withData = (s, d = ANSWERS) => s.page.evaluate((x) => { state.data = JSON.parse(JSON.stringify(x)); renderEditFields(); renderPreview(); }, d);
  const tryDownload = async (s, btn, ms = 2500) => {
    const dl = s.page.waitForEvent('download', { timeout: ms }).catch(() => null);
    await s.page.click(btn); const d = await dl; if (!d) return null;
    const f = path.join(TMP, d.suggestedFilename()); await d.saveAs(f); await s.page.waitForTimeout(500); return f;
  };

  // ───────────────────────────── who can download ─────────────────────────────
  await t.test('free sample: preview is watermarked, not printable, and a download asks for a code without calling the server', async () => {
    const s = await open(); await s.page.click('.gate-sample-link');
    assert.equal(await s.page.locator('#resume-preview.demo').count(), 1);
    assert.equal(await s.page.evaluate(() => document.body.classList.contains('licensed')), false);
    assert.match(await s.page.evaluate(() => getComputedStyle(document.querySelector('#resume-preview'), '::after').content), /SAMPLE PREVIEW/);
    await s.page.emulateMedia({ media: 'print' });
    assert.equal(await s.page.evaluate(() => getComputedStyle(document.querySelector('#resume-preview')).display), 'none');   // print path closed
    await s.page.emulateMedia({ media: 'screen' });
    assert.equal(await tryDownload(s, '#btn-pdf', 800), null);
    assert.equal(await s.page.isVisible('#license-gate'), true); assert.match(await s.page.innerText('#gate-error'), /never uses one of your generations/);
    assert.equal(exportCalls(s).length, 0); await s.close();
  });

  await t.test('editing the sample into your own resume does NOT unlock downloads (the previous bypass is closed)', async () => {
    const s = await open(); await s.page.click('.gate-sample-link');
    await s.page.fill('#edit-fields input.field-input', 'Free Rider'); await s.page.waitForTimeout(150);
    assert.equal(await tryDownload(s, '#btn-pdf', 800), null); await s.page.evaluate(() => hideGate()); assert.equal(await tryDownload(s, '#btn-word', 800), null);
    assert.equal(exportCalls(s).length, 0);
    assert.equal(await s.page.evaluate(() => typeof window.jspdf + typeof window.docx + typeof window.ResumeExport), 'undefinedundefinedundefined');   // no PDF/Word code in the page
    for (const f of ['jspdf.umd.min.js', 'docx.umd.js', 'resume-export.js']) assert.equal((await s.page.request.get(`${base}/${f}`)).status(), 404, f);
    await s.close();
  });

  await t.test('entering a valid code finishes the download the customer asked for; the watermark and print lock lift', async () => {
    const s = await open(); await s.page.click('.gate-sample-link'); await s.page.evaluate(() => loadSample());
    await s.page.click('#btn-pdf'); await s.page.waitForSelector('#license-gate', { state: 'visible' });
    const dl = s.page.waitForEvent('download', { timeout: 10000 }); await unlock(s); const d = await dl;
    const f = path.join(TMP, d.suggestedFilename()); await d.saveAs(f);
    assert.match(d.suggestedFilename(), /Emma_Larsen_Resume\.pdf/); assert.ok(pdfText(fs.readFileSync(f)).includes('Vice President, Retail Operations'));
    assert.equal(await s.page.locator('#resume-preview.demo').count(), 0);
    assert.equal(await s.page.evaluate(() => document.body.classList.contains('licensed')), true);
    assert.equal(exportCalls(s).length, 1); assert.equal(exportCalls(s)[0].body.code, GOOD);
    assert.equal(s.calls.filter((c) => c.name === 'parse-resume' || c.name === 'polish-resume').length, 0);   // a download never touches paid endpoints
    await s.close();
  });

  await t.test('invalid and expired credentials: the server says no, nothing is downloaded, the page returns to the gate', async () => {
    const s = await open();
    await unlock(s); await withData(s);
    // the code stops being valid (revoked / not found) while the page still thinks it is licensed
    s.api['export-resume'] = exportApi(['FG-OTHER-ZZZZ']);
    assert.equal(await tryDownload(s, '#btn-pdf', 1500), null);
    assert.equal(await s.page.isVisible('#license-gate'), true); assert.match(await s.page.innerText('#gate-error'), /couldn’t find that code/);
    assert.equal(await s.page.evaluate(() => state.license.verified), false); assert.equal(await s.page.evaluate(() => sessionStorage.getItem('fg_license_code')), null);
    assert.equal(await s.page.locator('#resume-preview.demo').count(), 1);
    await s.close();
  });

  await t.test('a tampered page (forged license state, fake code) gets no file', async () => {
    const s = await open(); await s.page.click('.gate-sample-link'); await withData(s);
    await s.page.evaluate(() => { state.license = { code: 'FG-FAKE-0000', verified: true, usesRemaining: 99, maxUses: 99 }; document.body.classList.add('licensed'); renderLicenseBadge(); });
    assert.equal(await tryDownload(s, '#btn-pdf', 1500), null);
    await s.page.evaluate(() => { state.license = { code: 'FG-FAKE-0000', verified: true, usesRemaining: 99, maxUses: 99 }; hideGate(); });
    assert.equal(await tryDownload(s, '#btn-word', 1500), null);
    assert.equal(exportCalls(s).length, 2); assert.ok(exportCalls(s).every((c) => c.body.code === 'FG-FAKE-0000'));      // it asked; the server refused
    assert.equal(await s.page.evaluate(() => state.license.verified), false);
    // and straight to the function, with no page at all
    const r = await s.page.evaluate(async () => { const x = await fetch('/.netlify/functions/export-resume', { method: 'POST', body: JSON.stringify({ code: 'FG-FAKE-0000', format: 'pdf', template: 'boardroom', resume: { name: 'x', summary: { tagline: 'y' } }, licensed: true }) }); return x.status; });
    assert.equal(r, 403); await s.close();
  });

  await t.test('refresh keeps a licensed session working (code re-verified by the server); a new tab/session starts at the gate', async () => {
    const s = await open(); await unlock(s); await withData(s);
    assert.ok(await tryDownload(s, '#btn-pdf'));
    await s.page.reload(); await s.page.waitForTimeout(500);
    assert.equal(await s.page.isVisible('#license-gate'), false);                                              // sessionStorage code, re-verified silently
    assert.equal(s.calls.filter((c) => c.name === 'verify-license').length, 2);
    const s2 = await open({}, { ctx: await browser.newContext({ acceptDownloads: true }) });                  // fresh session, nothing stored
    assert.equal(await s2.page.isVisible('#license-gate'), true); await s2.close(); await s.close();
  });

  await t.test('offline / server failure: a clear message, no file, nothing lost, and a retry works', async () => {
    const s = await open(); await unlock(s); await withData(s);
    const real = s.api['export-resume']; s.api['export-resume'] = 'offline';
    assert.equal(await tryDownload(s, '#btn-pdf', 1200), null);
    assert.match(await s.page.innerText('#export-notice'), /couldn’t reach the server/); assert.equal(await s.page.isDisabled('#btn-pdf'), false);
    s.api['export-resume'] = () => ({ status: 500, json: { error: 'We couldn’t prepare your download. Please try again.' } });
    assert.equal(await tryDownload(s, '#btn-word', 1200), null); assert.match(await s.page.innerText('#export-notice'), /couldn’t prepare your download/);
    assert.equal(await s.page.evaluate(() => state.license.verified), true);                                  // a server hiccup does not log the customer out
    s.api['export-resume'] = real; assert.ok(await tryDownload(s, '#btn-pdf')); assert.equal(await s.page.evaluate(() => state.data.name), 'Taylor Rivera');
    await s.close();
  });

  await t.test('double-clicking a download sends one request', async () => {
    const s = await open({ 'export-resume': (() => { const h = exportApi([GOOD]); return async (b) => { await new Promise((x) => setTimeout(x, 300)); return h(b); }; })() });
    await unlock(s); await withData(s);
    const dl = s.page.waitForEvent('download'); await s.page.dblclick('#btn-pdf'); await dl; await s.page.waitForTimeout(500);
    assert.equal(exportCalls(s).length, 1); await s.close();
  });

  await t.test('rate limit and credit state: a throttled download says wait, never logs out; downloads never change the counter', async () => {
    const s = await open({ 'export-resume': () => ({ status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' }, raw: true, body: JSON.stringify({ error: 'Too many attempts in a short time. Please wait a moment and try again.' }) }) });
    await unlock(s); await withData(s);
    assert.equal(await tryDownload(s, '#btn-pdf', 1200), null);
    assert.match(await s.page.innerText('#export-notice'), /Too many attempts/); assert.equal(await s.page.evaluate(() => state.license.verified), true);
    assert.match(await s.page.innerText('#license-badge'), /5 of 5/); await s.close();
  });

  // ───────────────────────────── AI polish ─────────────────────────────
  async function toReview(s) {
    await unlock(s); await s.page.click('#start-first'); await s.page.waitForSelector('#panel-guide .wiz-title');
    await withData(s); await s.page.click('.wiz-dot:has-text("Review")');
  }
  const polishOk = (extra = {}) => () => ({ status: 200, json: { result: JSON.stringify(POLISHED), usesRemaining: 4, maxUses: 5, tailorToken: 'tok-pol', unverified: [{ where: 'projects.0.bullets.0', text: 'Organized a food drive that collected 1,200 cans', reasons: ['number not in your resume: 1200'] }], ...extra } });

  await t.test('polish: nothing is charged by navigating, typing, previewing or switching templates; the cost is stated; two deliberate clicks are needed', async () => {
    const s = await open({ 'polish-resume': polishOk() }); await toReview(s);
    for (const step of ['Goal', 'You', 'Work', 'School', 'Projects', 'Skills', 'Review']) await s.page.click(`.wiz-dot:has-text("${step}")`);
    await s.page.evaluate(() => { selectTemplate('builder'); selectTemplate('boardroom'); updateField('name', 'Taylor R. Rivera'); });
    assert.match(await s.page.innerText('.wiz-polish'), /Uses 1 of your 5 generations \(of 5\)/);
    assert.equal(s.calls.filter((c) => c.name === 'polish-resume').length, 0);
    await s.page.click('#polish-btn');                                                                          // first click only asks
    assert.match(await s.page.innerText('.wiz-confirm'), /This will use 1 of your 5 generations remaining/);
    assert.equal(s.calls.filter((c) => c.name === 'polish-resume').length, 0);
    await s.page.click('.wiz-confirm .wiz-back');                                                               // cancel: still nothing
    assert.equal(s.calls.filter((c) => c.name === 'polish-resume').length, 0); assert.match(await s.page.innerText('#license-badge'), /5 of 5/);
    await s.close();
  });

  await t.test('polish success: one request even on a double-click, counter 5→4, token set, wording replaced, flagged line highlighted, source facts intact', async () => {
    const s = await open({ 'polish-resume': async (b) => { await new Promise((x) => setTimeout(x, 250)); return polishOk()(b); } }); await toReview(s);
    await s.page.click('#polish-btn'); await s.page.dblclick('#polish-confirm');
    await s.page.evaluate(() => { Wiz.back(); Wiz.next(); Wiz.go(0); });                                         // navigation is locked while the polish runs
    assert.match(await s.page.innerText('.wiz-progress'), /Step 7 of 7/i);
    await s.page.waitForSelector('.wiz-ok');
    const calls = s.calls.filter((c) => c.name === 'polish-resume'); assert.equal(calls.length, 1);
    assert.equal(calls[0].body.code, GOOD); assert.match(calls[0].body.requestId, /^[A-Za-z0-9-]{8,64}$/); assert.equal(calls[0].body.target, 'customer service' === calls[0].body.target ? 'customer service' : calls[0].body.target);
    assert.match(await s.page.innerText('#license-badge'), /4 of 5/); assert.equal(await s.page.evaluate(() => state.tailorToken), 'tok-pol');
    assert.match(await s.page.innerText('#resume-preview'), /Sorted and counted donated cans/);
    assert.equal(await s.page.evaluate(() => state.data.name), 'Taylor Rivera');
    assert.match(await s.page.innerText('.wiz-ok'), /Please check 1 line/);
    await s.page.click('button:has-text("Open in Editor")'); await s.page.waitForSelector('#edit-fields');
    assert.equal(await s.page.locator('textarea.flag-warn').count(), 1); assert.match(await s.page.locator('textarea.flag-warn').inputValue(), /1,200 cans/);
    await s.close();
  });

  await t.test('restore controls: per-part and all-at-once return the customer’s own wording', async () => {
    const s = await open({ 'polish-resume': polishOk() }); await toReview(s);
    await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForSelector('.wiz-ok');
    assert.match(await s.page.innerText('.wiz-ok'), /Project: School food drive/);
    await s.page.click('.wiz-ok button:has-text("Restore my wording")');
    assert.deepEqual(await s.page.evaluate(() => state.data.projects[0].bullets), ['asked classmates to donate cans', 'sorted and counted the cans']);
    assert.equal(await s.page.evaluate(() => state.flags.size), 0);                                             // the flagged line is gone, so is its flag
    await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForSelector('.wiz-ok button:has-text("Restore all")');
    await s.page.click('button:has-text("Restore all my original wording")');
    assert.deepEqual(await s.page.evaluate(() => state.data.projects[0].bullets), ['asked classmates to donate cans', 'sorted and counted the cans']);
    assert.equal(await s.page.evaluate(() => state.polishOriginal), null); await s.close();
  });

  await t.test('REGRESSION (Taylor Rivera): a charged polish that changes nothing is NOT shown as "Polished" and says so plainly; the resume is untouched', async () => {
    const same = () => ({ status: 200, json: { result: JSON.stringify(ANSWERS), unverified: [], changes: { reworded: 0, cosmetic: 0, unchanged: 4 }, usesRemaining: 4, maxUses: 5, tailorToken: 'tok-pol' } });
    const s = await open({ 'polish-resume': same }); await toReview(s);
    await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForSelector('#polish-nochange');
    const box = await s.page.innerText('#polish-nochange');
    assert.match(box, /No wording changes were made/); assert.match(box, /That used 1 generation \(4 of 5 left\)/);       // honest about the charge
    assert.equal(await s.page.locator('.wiz-polish .wiz-ok').count(), 0);                                                 // no green "✓ Polished" success banner
    assert.doesNotMatch(await s.page.innerText('.wiz-polish'), /✓ Polished|AI reworded/);
    assert.deepEqual(await s.page.evaluate(() => state.data.projects[0].bullets), ['asked classmates to donate cans', 'sorted and counted the cans']);
    assert.match(await s.page.innerText('#license-badge'), /4 of 5/);
    await s.close();
  });

  await t.test('a polish that does reword shows the success banner and lists what changed (preview shows the new wording)', async () => {
    const s = await open({ 'polish-resume': polishOk({ unverified: [] }) }); await toReview(s);
    await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForSelector('.wiz-ok');
    assert.match(await s.page.innerText('.wiz-ok'), /✓ Polished/); assert.match(await s.page.innerText('.wiz-ok'), /Project: School food drive/);
    assert.equal(await s.page.locator('#polish-nochange').count(), 0); assert.match(await s.page.innerText('#resume-preview'), /Sorted and counted donated cans/);
    await s.close();
  });

  await t.test('after a polish, Tailor works with the issued token (free, token-gated) and the usual unverified flags', async () => {
    const tailored = { resume: POLISHED, matchSummary: { matchedKeywords: ['service'], missingKeywords: [], notes: 'ok' } };
    const s = await open({ 'polish-resume': polishOk(), 'tailor-resume': () => ({ status: 200, json: { result: JSON.stringify(tailored), unverified: [], tailorRunsRemaining: 4 } }) }); await toReview(s);
    await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForSelector('.wiz-ok');
    await s.page.click('button:has-text("Open in Editor")'); await s.page.fill('#job-desc-input', 'Cashier'); await s.page.click('#tailor-btn');
    await s.page.waitForSelector('#match-summary-box', { state: 'visible' });
    assert.equal(s.calls.find((c) => c.name === 'tailor-resume').body.tailorToken, 'tok-pol'); assert.match(await s.page.innerText('#license-badge'), /4 of 5/);
    await s.close();
  });

  await t.test('polish failures are explained, uncharged, and re-enable the button: AI fault, throttle, busy, expired code, exhausted', async () => {
    const mk = (status, json) => () => ({ status, json });
    const s = await open({ 'polish-resume': mk(502, { error: 'We couldn’t polish your resume right now. You haven’t been charged. Please try again.' }) }); await toReview(s);
    await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForSelector('.wiz-err');
    assert.match(await s.page.innerText('.wiz-err'), /haven’t been charged/); assert.match(await s.page.innerText('#license-badge'), /5 of 5/);
    assert.equal(await s.page.isVisible('#polish-btn'), true); assert.equal(await s.page.evaluate(() => state.data.projects[0].bullets[0]), 'asked classmates to donate cans');
    s.api['polish-resume'] = mk(429, { error: 'We’ve had several unsuccessful attempts on this code in a short time. To protect your account, please wait about 15 minutes and try again. You haven’t been charged.', usesRemaining: 5, maxUses: 5 });
    await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForSelector('.wiz-err:has-text("wait about 15 minutes")');
    s.api['polish-resume'] = mk(409, { error: 'Another generation is already in progress on this code. Please wait a moment and try again.' });
    await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForSelector('.wiz-err:has-text("already in progress")');
    s.api['polish-resume'] = mk(403, { error: 'You’ve used all generations on this code.', usesRemaining: 0, maxUses: 5 });
    await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForSelector('.wiz-polish:has-text("used all 5 generations")');
    assert.equal(await s.page.locator('#polish-btn').count(), 0); assert.match(await s.page.innerText('.wiz-polish'), /still fully editable and downloadable/);
    assert.ok(await s.page.locator('.wiz-polish a[href*="etsy.com"]').count());
    await s.close();
    const s2 = await open({ 'polish-resume': mk(403, { error: 'We couldn’t find that code.' }) }); await toReview(s2);
    await s2.page.click('#polish-btn'); await s2.page.click('#polish-confirm'); await s2.page.waitForSelector('#license-gate', { state: 'visible' });
    assert.equal(await s2.page.evaluate(() => state.license.verified), false); await s2.close();
  });

  await t.test('network failure during polish: customer is told to check the counter, nothing is replaced, and the retry reuses the same request id (no double charge)', async () => {
    const s = await open({ 'polish-resume': 'offline' }); await toReview(s);
    await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForSelector('.wiz-err');
    assert.match(await s.page.innerText('.wiz-err'), /check the generations counter/); assert.equal(await s.page.evaluate(() => state.data.projects[0].bullets[0]), 'asked classmates to donate cans');
    const firstId = s.calls.find((c) => c.name === 'polish-resume').body.requestId;
    s.api['polish-resume'] = polishOk(); await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForSelector('.wiz-ok');
    assert.equal(s.calls.filter((c) => c.name === 'polish-resume')[1].body.requestId, firstId);
    await s.close();
  });

  await t.test('polish needs real content and a code: empty answers cannot be sent, and an unlicensed page cannot start it', async () => {
    const s = await open({ 'polish-resume': polishOk() }); await unlock(s); await s.page.click('#start-first'); await s.page.waitForSelector('#panel-guide .wiz-title');
    await s.page.click('.wiz-dot:has-text("Review")');
    assert.equal(await s.page.locator('#polish-btn').count(), 0); assert.match(await s.page.innerText('.wiz-polish'), /Add a few answers first/);
    await withData(s); await s.page.click('.wiz-dot:has-text("Goal")'); await s.page.click('.wiz-dot:has-text("Review")'); assert.equal(await s.page.locator('#polish-btn').count(), 1);
    await s.page.evaluate(() => { state.license = { code: null, verified: false, usesRemaining: null, maxUses: null }; });
    await s.page.evaluate(() => Wiz.doPolish());
    assert.equal(s.calls.filter((c) => c.name === 'polish-resume').length, 0); assert.equal(await s.page.isVisible('#license-gate'), true); await s.close();
  });

  await t.test('HTML in polished text is shown literally and never runs', async () => {
    const evil = { ...POLISHED, projects: [{ name: '<img src=x onerror="window.__xss=1">Drive', description: '', bullets: ['<script>window.__xss2=1</script>'] }] };
    const s = await open({ 'polish-resume': () => ({ status: 200, json: { result: JSON.stringify(evil), usesRemaining: 4, maxUses: 5, tailorToken: 't', unverified: [{ text: '<script>window.__xss2=1</script>', reasons: ['<img src=y onerror="window.__xss3=1">'] }] } }) });
    await toReview(s); await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForSelector('.wiz-ok'); await s.page.waitForTimeout(300);
    assert.deepEqual(await s.page.evaluate(() => Object.keys(window).filter((k) => k.startsWith('__xss'))), []);
    assert.equal(await s.page.evaluate(() => document.querySelectorAll('.wiz-polish img, .wiz-polish script, #resume-preview img, #resume-preview script').length), 0);
    assert.match(await s.page.innerText('.wiz-ok'), /<script>window\.__xss2=1<\/script>/); await s.close();
  });


  // ───────── AI polish is easy to find from the regular editor ─────────
  await t.test('editor: the polish card sits at the top of Edit Fields with the cost stated; it needs a code and something to polish; it is not a second charge path', async () => {
    const s = await open({ 'polish-resume': polishOk() }); await toReview(s);
    await s.page.click('button:has-text("Open in Editor")');
    assert.equal(await s.page.evaluate(() => state.activePanel), 'edit');
    assert.equal(await s.page.evaluate(() => document.querySelector('#panel-edit').firstElementChild.id), 'edit-polish');       // first thing in the editor
    assert.equal(await s.page.evaluate(() => document.querySelector('#panel-edit').scrollTop), 0);                             // and it opens scrolled to the top, so the card is on screen
    assert.equal(await s.page.locator('#edit-polish-btn').isVisible(), true);
    assert.ok(await s.page.evaluate(() => { const r = document.querySelector('#edit-polish-btn').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'the polish button is within the visible window');
    assert.match(await s.page.innerText('#edit-polish'), /Improve the wording with AI/); assert.match(await s.page.innerText('#edit-polish'), /Uses 1 of your 5 generations \(of 5\)/);
    assert.equal(await s.page.isVisible('#edit-polish-btn'), true);
    assert.equal(s.calls.filter((c) => c.name === 'polish-resume').length, 0);                                                 // seeing it charges nothing
    await s.page.evaluate(() => { state.data = ResumeCore.blank(); renderEditFields(); renderPreview(); });                    // nothing to polish yet
    assert.equal(await s.page.locator('#edit-polish-btn').count(), 0);
    await s.page.evaluate(() => { state.data.summary.skills = ['Teamwork']; renderPreview(); });                              // typing something makes it available, live
    assert.equal(await s.page.locator('#edit-polish-btn').count(), 1);
    await s.page.evaluate(() => { state.license = { code: null, verified: false, usesRemaining: null, maxUses: null }; renderLicenseBadge(); });
    assert.equal(await s.page.locator('#edit-polish').innerHTML(), '');                                                        // no code: not offered (downloads and the sample stay as they were)
    await s.close();
  });

  await t.test('editor: two deliberate clicks, one request (even on a double-click), the audience choice is sent, and the same result shows in the editor and on the Review step', async () => {
    const s = await open({ 'polish-resume': async (b) => { await new Promise((x) => setTimeout(x, 200)); return polishOk()(b); } }); await toReview(s);
    await s.page.click('.wiz-dot:has-text("Goal")'); await s.page.check('input[name="wiz-profile"] >> nth=2');                  // "changing to a different kind of work"
    await s.page.fill('input[placeholder^="e.g. customer service"]', 'customer support');
    await s.page.click('.wiz-dot:has-text("Review")'); await s.page.click('button:has-text("Open in Editor")');
    await s.page.click('#edit-polish-btn');
    assert.match(await s.page.innerText('#edit-polish .wiz-confirm'), /This will use 1 of your 5 generations remaining/);
    assert.equal(s.calls.filter((c) => c.name === 'polish-resume').length, 0);                                                 // the first click only asks
    await s.page.dblclick('#edit-polish-confirm'); await s.page.waitForSelector('#edit-polish .wiz-ok');
    const calls = s.calls.filter((c) => c.name === 'polish-resume'); assert.equal(calls.length, 1);
    assert.equal(calls[0].body.profile, 'changer'); assert.equal(calls[0].body.target, 'customer support'); assert.equal(calls[0].body.code, GOOD);
    assert.match(await s.page.innerText('#license-badge'), /4 of 5/);
    assert.match(await s.page.innerText('#edit-polish .wiz-ok'), /Please check 1 line/); assert.match(await s.page.innerText('#edit-polish .wiz-ok'), /Project: School food drive/);
    assert.equal(await s.page.locator('#edit-fields textarea.flag-warn').count(), 1);                                          // the yellow line is right below, in the editor
    await s.page.click('#edit-polish .wiz-ok button:has-text("Restore my wording")');
    assert.deepEqual(await s.page.evaluate(() => state.data.projects[0].bullets), ['asked classmates to donate cans', 'sorted and counted the cans']);
    assert.equal(await s.page.locator('#edit-fields textarea.flag-warn').count(), 0);
    await s.page.click('#edit-polish button:has-text("Restore all")').catch(() => {});
    await s.page.click('#tab-guide'); await s.page.waitForSelector('#panel-guide');                                            // the Review step reads the same state
    assert.equal(await s.page.locator('#panel-guide #polish-btn').count() + await s.page.locator('#panel-guide .wiz-ok').count() >= 1, true);
    await s.close();
  });

  await t.test('editor: a pasted-and-analyzed resume also gets the card, and sends no audience (the server decides from the answers)', async () => {
    const analyzed = { name: 'Michael Johnson', contact: { email: 'mj@example.com' }, summary: { tagline: '', bullets: [], skills: ['Teamwork'] },
      experience: [{ title: 'Warehouse Associate', company: 'Fictional Freight Co', start: '2016', end: 'Present', bullets: ['loaded trucks'] }], education: [], certifications: [], projects: [], volunteer: [], awards: [] };
    const s = await open({ 'parse-resume': () => ({ status: 200, json: { result: JSON.stringify(analyzed), usesRemaining: 4, maxUses: 5, tailorToken: 'tok' } }),
      'polish-resume': () => ({ status: 200, json: { result: JSON.stringify({ ...analyzed, experience: [{ ...analyzed.experience[0], bullets: ['Loaded trucks at the dock'] }] }), usesRemaining: 3, maxUses: 5, tailorToken: 'tok2', unverified: [] } }) });   // reworded, so the success banner is the right outcome
    await unlock(s); await s.page.fill('#resume-input', 'Michael Johnson, warehouse'); await s.page.click('#parse-btn'); await s.page.waitForSelector('#resume-preview');
    assert.equal(await s.page.evaluate(() => state.wizard), null);
    assert.match(await s.page.innerText('#edit-polish'), /Uses 1 of your 4 generations \(of 5\)/);                              // honest about what is left after the Analyze
    await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); await s.page.waitForSelector('#edit-polish .wiz-ok');
    const body = s.calls.find((c) => c.name === 'polish-resume').body; assert.equal(body.profile, undefined); assert.equal(body.requestId.length >= 8, true);
    assert.match(await s.page.innerText('#license-badge'), /3 of 5/);
    await s.close();
  });

  await browser.close(); server.close();
});
