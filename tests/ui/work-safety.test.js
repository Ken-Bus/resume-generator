// The customer's work is not lost: a reload, a phone browser discarding the tab, a lost AI reply. And the page works when browser storage is blocked.
// Endpoints are mocked and every call is recorded; nothing leaves the machine. Fictional applicants only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { PW, CHROME, unavailable } = require('./browser');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
function serve() {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}
const RESUME = { name: 'Jordan Ellis', contact: { email: 'jordan.ellis@example.com' }, summary: { tagline: '', bullets: [], skills: ['Customer service'] },
  experience: [{ title: 'Retail Associate', company: 'Fictional Maple Market', start: 'June 2023', end: 'August 2026', bullets: ['assisted customers', 'stocked shelves'] }], education: [], certifications: [], projects: [], awards: [] };
const POLISHED = JSON.parse(JSON.stringify(RESUME)); POLISHED.experience[0].bullets = ['Assisted customers at the register', 'Stocked shelves'];

test('work safety (Chromium, mocked endpoints)', async (t) => {
  if (unavailable(t)) return;
  const { chromium } = require(PW);
  const server = await serve(); const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME });

  async function open(api = {}, { ctx = null, blockStorage = false } = {}) {
    const context = ctx || await browser.newContext({ acceptDownloads: true });
    if (blockStorage) await context.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } }); });
    const page = await context.newPage(); const calls = []; const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.includes('/.netlify/functions/')) {
        const name = url.split('/.netlify/functions/')[1]; let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (e) {}
        calls.push({ name, body });
        const r = await (api[name] || (() => ({ status: 500, json: { error: 'unmocked' } })))(body, calls.filter((c) => c.name === name).length);
        if (r.delay) await new Promise((x) => setTimeout(x, r.delay));
        if (r.raw) return route.fulfill({ status: r.status, headers: r.headers, body: Buffer.from(r.body || '', r.isBase64Encoded ? 'base64' : 'utf8') });
        return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.json) });
      }
      if (url.startsWith(base)) return route.continue();
      return route.abort();
    });
    await page.goto(base + '/index.html');
    return { page, calls, errors, context, close: () => context.close() };
  }
  const verifyOk = () => ({ status: 200, json: { valid: true, usesRemaining: 5, maxUses: 5 } });
  async function unlock(page) { await page.fill('#gate-code-input', 'FG-TEST-AAAA'); await page.click('#gate-unlock-btn'); await page.waitForSelector('#license-gate', { state: 'hidden' }); }
  const putResume = (page, data = RESUME) => page.evaluate((r) => { state.data = JSON.parse(JSON.stringify(r)); renderEditFields(); renderPreview(); switchPanel('edit'); }, data);
  const reload = async (s) => { await s.page.reload(); await s.page.waitForSelector('#export-bar, #license-gate, .start-paths', { state: 'attached' }); await s.page.waitForTimeout(150); };

  await t.test('a reload brings the resume back exactly, with a notice, and the code still works', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page); await putResume(s.page);
    await s.page.fill('input[oninput*="experience\',0,\'title\'"]', 'Senior Retail Associate');          // an edit made after the resume was loaded
    await reload(s);
    assert.match(await s.page.innerText('#resume-preview'), /JORDAN ELLIS/i); assert.match(await s.page.innerText('#resume-preview'), /Senior Retail Associate/);
    assert.equal(await s.page.isVisible('#restore-notice'), true); assert.match(await s.page.innerText('#restore-notice'), /nothing you typed was lost/i);
    assert.equal(await s.page.isVisible('#export-bar'), true); assert.equal(s.errors.length, 0, s.errors.join('|'));
    assert.match(await s.page.innerText('#license-badge'), /5 of 5/);
    await s.close();
  });

  await t.test('OFFLINE: the connection drops while the customer is typing; nothing is lost, a reload (back online) restores everything, and the paid step explains itself and charges nothing', async () => {
    const s = await open({ 'verify-license': verifyOk, 'polish-resume': () => ({ status: 200, json: { noChange: true } }) }); await unlock(s.page); await putResume(s.page);
    await s.context.setOffline(true);
    await s.page.fill('input[oninput*="experience\',0,\'title\'"]', 'Lead Retail Associate (typed offline)'); await s.page.waitForTimeout(500);
    assert.match(await s.page.innerText('#resume-preview'), /typed offline/);                       // the page keeps working with no network
    await s.context.setOffline(false); await reload(s);
    assert.match(await s.page.innerText('#resume-preview'), /typed offline/); assert.equal(s.errors.length, 0, s.errors.join('|'));
    await s.close();
  });

  await t.test('BACK / FORWARD: leaving the page and coming back with the browser buttons brings the resume back', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page); await putResume(s.page);
    await s.page.fill('input[oninput*="experience\',0,\'title\'"]', 'Shift Lead'); await s.page.waitForTimeout(500);
    await s.page.goto(base + '/404.html'); await s.page.goBack(); await s.page.waitForSelector('#export-bar, #license-gate, .start-paths', { state: 'attached' }); await s.page.waitForTimeout(300);
    assert.match(await s.page.innerText('#resume-preview'), /Shift Lead/); assert.equal(s.errors.length, 0, s.errors.join('|'));
    await s.close();
  });

  await t.test('DOUBLE SUBMIT (two calls in the same instant, as a double tap can produce): exactly ONE polish request is sent and no error is shown', async () => {
    const polishApi = async () => ({ status: 200, delay: 300, json: { guard: 'x', result: JSON.stringify(POLISHED), unverified: [], withheld: [], changes: { reworded: 1, minor: 0, cosmetic: 0, unchanged: 0, dropped: 0 }, points: 3, threshold: 3, charged: true, usesRemaining: 4, maxUses: 5, tailorToken: 'tok' } });
    const s = await open({ 'verify-license': verifyOk, 'polish-resume': polishApi }); await unlock(s.page); await putResume(s.page);
    await s.page.evaluate(() => { Wiz.askPolish(); Wiz.doPolish(); Wiz.doPolish(); Wiz.doPolish(); });
    await s.page.waitForFunction(() => !Wiz.polishState().busy); await s.page.waitForTimeout(200);
    assert.equal(s.calls.filter((c) => c.name === 'polish-resume').length, 1); assert.equal(await s.page.locator('.wiz-err').count(), 0);
    assert.doesNotMatch(await s.page.innerText('body'), /Please wait until the AI step that is already running/, 'the extra taps are ignored silently: no scary "busy" error for a double tap');
    assert.match(await s.page.innerText('#license-badge'), /4 of 5/);
    await s.close();
  });

  await t.test('the untouched free sample is not saved: a reload starts fresh', async () => {
    const s = await open({}); await s.page.click('.gate-sample-link'); await s.page.waitForSelector('#resume-preview');
    assert.equal(await s.page.evaluate(() => sessionStorage.getItem('fg_work_v1')), null);
    await reload(s); assert.equal(await s.page.isVisible('#restore-notice'), false); assert.equal(await s.page.isVisible('#start-paths'), true);
    await s.close();
  });

  await t.test('the Guided Builder returns to the same step with the answers typed so far', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page);
    await s.page.click('#start-first'); await s.page.waitForSelector('.wiz-title');
    await s.page.click('.wiz-next'); await s.page.fill('.wiz-input >> nth=0', 'Alex Moreno'); await s.page.fill('.wiz-input >> nth=2', 'alex@example.com');
    await reload(s);
    assert.match(await s.page.innerText('.wiz-progress'), /step 2 of 7/i); assert.equal(await s.page.inputValue('.wiz-input >> nth=0'), 'Alex Moreno');
    assert.match(await s.page.innerText('#resume-preview'), /ALEX MORENO/i);
    await s.close();
  });

  await t.test('the pasted text and the job description are kept too', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page); await putResume(s.page);
    await s.page.fill('#job-desc-input', 'Cashier wanted for a small store'); await s.page.click('#tab-paste'); await s.page.fill('#resume-input', 'Jordan Ellis, retail, three years');
    await s.page.waitForTimeout(450); await reload(s);
    assert.equal(await s.page.inputValue('#resume-input'), 'Jordan Ellis, retail, three years'); assert.equal(await s.page.inputValue('#job-desc-input'), 'Cashier wanted for a small store');
    await s.close();
  });

  await t.test('RELOAD DURING A PAID POLISH: the interrupted step is explained, and running it again reuses the SAME request id (so a finished step is not charged twice)', async () => {
    let first = true;
    const api = { 'verify-license': verifyOk, 'polish-resume': (body) => { if (first) { first = false; return { delay: 1500, status: 200, json: { result: JSON.stringify(POLISHED), usesRemaining: 4, maxUses: 5, tailorToken: 'tok', changes: { reworded: 1 }, charged: true, unverified: [], withheld: [] } }; }
      return { status: 200, json: { result: JSON.stringify(POLISHED), usesRemaining: 4, maxUses: 5, tailorToken: 'tok', changes: { reworded: 1 }, charged: true, unverified: [], withheld: [] } }; } };
    const s = await open(api); await unlock(s.page); await putResume(s.page);
    await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); await s.page.waitForTimeout(300);
    const id1 = s.calls.find((c) => c.name === 'polish-resume').body.requestId; assert.match(id1, /^[A-Za-z0-9-]{8,64}$/);
    await reload(s);
    assert.match(await s.page.innerText('#restore-notice'), /AI Polish\) may have been interrupted/i);
    await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); await s.page.waitForSelector('#edit-polish-summary, .wiz-ok', { timeout: 5000 });
    const second = s.calls.filter((c) => c.name === 'polish-resume')[1]; assert.equal(second.body.requestId, id1, 'the same request id is reused after the reload');
    assert.match(await s.page.innerText('#resume-preview'), /Assisted customers at the register/);
    await s.close();
  });

  await t.test('Analyze: after a lost reply the retry reuses the request id; new text gets a new one; a definite answer clears it', async () => {
    let n = 0;
    const api = { 'verify-license': verifyOk, 'parse-resume': () => { n++; return n === 1 ? { status: 200, raw: true, headers: { 'Content-Type': 'application/json' }, body: '{"result":' } /* a cut-off reply */ : { status: 200, json: { result: JSON.stringify(RESUME), usesRemaining: 4, maxUses: 5, tailorToken: 't', unverified: [] } }; } };
    const s = await open(api); await unlock(s.page); await s.page.fill('#resume-input', 'Jordan Ellis, retail, three years'); await s.page.click('#parse-btn'); await s.page.waitForTimeout(500);
    await s.page.click('#parse-btn'); await s.page.waitForSelector('#resume-preview'); await s.page.waitForTimeout(200);
    const ids = s.calls.filter((c) => c.name === 'parse-resume').map((c) => c.body.requestId);
    assert.equal(ids.length, 2); assert.equal(ids[0], ids[1], 'same text, same request id');
    assert.equal(await s.page.evaluate(() => state.pending), null, 'a definite answer clears the pending record');
    await s.close();
  });

  await t.test('leaving: a resume that has not been downloaded asks first; after a download, and for the free sample, it does not', async () => {
    // The browser decides how to show the question; what the page controls is whether it asks. (A cancelable beforeunload event is what the browser sends.)
    const asks = (page) => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    const pdf = () => ({ status: 200, raw: true, isBase64Encoded: true, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="x.pdf"' }, body: Buffer.from('%PDF-1.4 test').toString('base64') });
    const s = await open({ 'verify-license': verifyOk, 'export-resume': pdf }); await unlock(s.page);
    assert.equal(await asks(s.page), false, 'nothing typed yet: no question');
    await putResume(s.page); assert.equal(await asks(s.page), true, 'unsaved work: the browser is asked to confirm leaving');
    const dl = s.page.waitForEvent('download'); await s.page.click('#btn-pdf'); await dl; await s.page.waitForTimeout(200);
    assert.equal(await asks(s.page), false, 'downloaded: no question');
    await s.page.fill('input[oninput*="experience\',0,\'title\'"]', 'Changed after download'); assert.equal(await asks(s.page), true, 'edited after the download: asks again');
    await s.close();
    const s3 = await open({}); await s3.page.click('.gate-sample-link'); await s3.page.waitForSelector('#resume-preview');
    assert.equal(await asks(s3.page), false, 'the untouched sample has nothing to lose'); await s3.close();
    const s4 = await open({ 'verify-license': verifyOk }); await unlock(s4.page); await putResume(s4.page);
    await s4.page.evaluate(() => { state.aiBusy = 'polish'; }); assert.equal(await asks(s4.page), true, 'a paid AI step is running: leaving may lose its result');
    await s4.page.evaluate(() => { state.aiBusy = null; }); await s4.close();
  });

  await t.test('"Clear this saved copy" removes the stored work, and a reload then starts fresh', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page); await putResume(s.page); await reload(s);
    s.page.on('dialog', (d) => d.accept());
    await s.page.click('#restore-notice .wiz-link'); await s.page.waitForSelector('.start-paths, #license-gate', { state: 'attached' }); await s.page.waitForTimeout(300);
    assert.equal(await s.page.evaluate(() => sessionStorage.getItem('fg_work_v1')), null, 'nothing is stored');
    assert.equal(await s.page.evaluate(() => state.data), null, 'and the page has started over (otherwise the work on screen would simply be saved again)');
    await reload(s); assert.equal(await s.page.isVisible('#restore-notice'), false);
    await s.close();
  });

  await t.test('STORAGE BLOCKED (private or in-app browsers): the page still loads, the code gate works, and nothing crashes', async () => {
    const s = await open({ 'verify-license': verifyOk }, { blockStorage: true });
    assert.equal(await s.page.isVisible('#license-gate'), true); await unlock(s.page); await putResume(s.page);
    assert.match(await s.page.innerText('#resume-preview'), /JORDAN ELLIS/i);
    assert.equal(s.errors.length, 0, s.errors.join('|'));
    await s.close();
  });

  await t.test('TWO POLISHES: what the customer wrote before the FIRST polish is still one click away (it used to be lost)', async () => {
    const P1 = JSON.parse(JSON.stringify(RESUME)); P1.experience[0].bullets = ['Assisted customers at the register', 'Stocked shelves'];
    const P2 = JSON.parse(JSON.stringify(RESUME)); P2.experience[0].bullets = ['Assisted customers at the front register', 'Stocked shelves'];
    let n = 0; const ans = (r) => ({ status: 200, json: { result: JSON.stringify(r), usesRemaining: 5 - n, maxUses: 5, tailorToken: 'tok', changes: { reworded: 1 }, charged: true, unverified: [], withheld: [] } });
    const s = await open({ 'verify-license': verifyOk, 'polish-resume': () => { n++; return ans(n === 1 ? P1 : P2); } }); await unlock(s.page); await putResume(s.page);
    s.page.on('dialog', (d) => d.accept());
    const polish = async () => { await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); await s.page.waitForFunction((k) => document.querySelectorAll('#edit-polish .wiz-ok').length === 1 && !document.querySelector('#edit-polish .spinner') && k === k, n + 1); };
    await polish(); assert.equal(await s.page.isVisible('#edit-restore-first'), false, 'after one polish, "restore all" already goes back to the customer\'s own words');
    await polish(); assert.match(await s.page.innerText('#resume-preview'), /front register/); assert.equal(await s.page.isVisible('#edit-restore-first'), true);
    await s.page.click('#edit-polish .wiz-link >> text=Restore all my original wording'); assert.match(await s.page.innerText('#resume-preview'), /at the register/); assert.doesNotMatch(await s.page.innerText('#resume-preview'), /front register/);
    assert.equal(await s.page.isVisible('#edit-restore-first'), true, 'still reachable after restoring only the last polish');
    await s.page.click('#edit-restore-first'); const text = await s.page.innerText('#resume-preview');
    assert.match(text, /assisted customers/i); assert.doesNotMatch(text, /at the register|front register/); assert.equal(await s.page.isVisible('#edit-restore-first'), false);
    assert.deepEqual(await s.page.evaluate(() => state.data.experience[0].bullets), RESUME.experience[0].bullets);
    await s.close();
  });

  await t.test('a damaged or foreign saved copy is ignored, never a crash', async () => {
    const s = await open({ 'verify-license': verifyOk });
    await s.page.evaluate(() => sessionStorage.setItem('fg_work_v1', '{"v":1,"data":"not an object"}'));
    await reload(s); assert.equal(await s.page.isVisible('#license-gate'), true); assert.equal(s.errors.length, 0, s.errors.join('|'));
    await s.page.evaluate(() => sessionStorage.setItem('fg_work_v1', '{bad json'));
    await reload(s); assert.equal(await s.page.isVisible('#license-gate'), true); assert.equal(s.errors.length, 0, s.errors.join('|'));
    await s.close();
  });

  await browser.close(); server.close();
});
