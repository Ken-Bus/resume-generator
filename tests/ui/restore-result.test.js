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

test('Restore my result (Chromium, mocked endpoints, fictional data)', async (t) => {
  if (unavailable(t)) return;
  const { chromium } = require(PW);
  const server = await serve(); const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME });

  async function open(api = {}, { ctx = null, blockStorage = false, storageState = null, initScript = null } = {}) {
    const context = ctx || await browser.newContext({ acceptDownloads: true, ...(storageState ? { storageState } : {}) });
    if (blockStorage) await context.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } }); });
    if (initScript) await context.addInitScript(initScript);
    const page = await context.newPage(); const calls = []; const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.includes('/.netlify/functions/')) {
        const name = url.split('/.netlify/functions/')[1]; let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (e) {}
        calls.push({ name, body });
        if (api[name] === 'offline') return route.abort('internetdisconnected');
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

  const STEP = 'aaaaaaaa-1111-4222-8333-444444444444';
  const savedList = (kind = 'polish', id = STEP) => ({ status: 200, json: { results: [{ id, kind, savedAt: new Date(Date.now() - 3600e3).toISOString(), expiresAt: new Date(Date.now() + 23 * 3600e3).toISOString() }], usesRemaining: 4, maxUses: 5 } });
  const POLISHED_FULL = JSON.parse(JSON.stringify(RESUME)); POLISHED_FULL.experience[0].bullets = ['Assisted customers at the register', 'Stocked shelves'];
  const fetched = (kind = 'polish', extra = {}) => ({ status: 200, json: { result: JSON.stringify(POLISHED_FULL), unverified: [], withheld: [], changes: { reworded: 1, minor: 0, cosmetic: 0, unchanged: 0, dropped: 0 }, points: 3, threshold: 3, charged: true, usesRemaining: 4, maxUses: 5, tailorToken: 'restored-tok', recovered: 'exact', message: 'Your earlier result has been restored exactly as it was. No additional generation was used.', supportRef: 'R-AAAAAAAA', saved: true, kind, savedAt: new Date(Date.now() - 3600e3).toISOString(), expiresAt: new Date(Date.now() + 23 * 3600e3).toISOString(), ...extra } });
  const recoverApi = (list, fetchResp) => (b) => (b.action === 'list' ? list : fetchResp);
  const calls = (s, n) => s.calls.filter((c) => c.name === n);

  await t.test('THE MAIN SCENARIO: power cut after a paid Polish, browser restarted, nothing stored: enter the access code -> "Restore my result" -> the exact result is on screen, no generation used, no resume re-entered, Tailor still usable', async () => {
    const s = await open({ 'verify-license': verifyOk, 'recover-result': recoverApi(savedList(), fetched()) }); await unlock(s.page); await s.page.waitForTimeout(300);
    assert.equal(await s.page.isVisible('#recover-banner'), true); const bt = await s.page.innerText('#recover-banner');
    assert.match(bt, /A finished result is saved for you/); assert.match(bt, /does not use another generation/); assert.match(bt, /encrypted copy for up to 24 hours/); assert.match(bt, /Only your access code unlocks it/); assert.match(bt, /AI Polish finished/);
    assert.equal(await s.page.evaluate(() => state.data && state.data.name), null, 'nothing applied until the customer chooses');
    await s.page.click(`#restore-${STEP}`); await s.page.waitForTimeout(300);
    assert.match(await s.page.innerText('#resume-preview'), /Assisted customers at the register/); assert.equal(await s.page.evaluate(() => state.tailorToken), 'restored-tok');
    const nt = await s.page.innerText('#restore-notice'); assert.match(nt, /Your saved result is back/); assert.match(nt, /exactly as it was/); assert.match(nt, /No generation was used/);
    assert.equal(await s.page.isVisible('#recover-banner'), false); assert.match(await s.page.innerText('#license-badge'), /4 of 5/);
    assert.deepEqual(calls(s, 'polish-resume').concat(calls(s, 'parse-resume'), calls(s, 'tailor-resume')), [], 'no AI step was called');
    assert.equal(calls(s, 'recover-result').length, 2, 'one list, one fetch'); assert.equal(JSON.stringify(calls(s, 'recover-result').map((c) => c.body)).includes('Assisted'), false, 'the resume was never sent');
    assert.equal(s.errors.length, 0, s.errors.join('|')); await s.close();
  });

  await t.test('ANALYZE result: the restored resume appears with its "please check" lines and the recovered notice; the editor opens', async () => {
    const analyzed = fetched('analyze', { unverified: [{ text: 'Served 200 customers', reasons: ['number not in your resume: 200'] }], recovered: 'exact' });
    const s = await open({ 'verify-license': verifyOk, 'recover-result': recoverApi(savedList('analyze'), analyzed) }); await unlock(s.page); await s.page.waitForTimeout(300); await s.page.click(`#restore-${STEP}`); await s.page.waitForTimeout(300);
    assert.equal(await s.page.evaluate(() => state.activePanel), 'edit'); assert.match(await s.page.innerText('#analyze-notice'), /Your earlier result is back/); assert.match(await s.page.innerText('#analyze-notice'), /Please check 1 line/); await s.close();
  });

  await t.test('NOTHING SAVED, or the check fails (offline, server error): no banner, no error, no noise for ordinary customers', async () => {
    for (const api of [() => ({ status: 200, json: { results: [], usesRemaining: 5, maxUses: 5 } }), () => ({ status: 503, json: { error: 'x' } }), () => ({ status: 500, json: {} })]) {
      const s = await open({ 'verify-license': verifyOk, 'recover-result': api }); await unlock(s.page); await s.page.waitForTimeout(300);
      assert.equal(await s.page.isVisible('#recover-banner'), false); assert.equal(s.errors.length, 0, s.errors.join('|')); await s.close();
    }
    const s = await open({ 'verify-license': verifyOk, 'recover-result': 'offline' }); s.page.on('requestfailed', () => {}); await unlock(s.page); await s.page.waitForTimeout(300); assert.equal(await s.page.isVisible('#recover-banner'), false); await s.close();
  });

  await t.test('CURRENT WORK IS PROTECTED: with a resume on screen the customer is asked first; declining changes nothing; accepting replaces it and "Undo" brings the earlier work back exactly', async () => {
    const s = await open({ 'verify-license': verifyOk, 'recover-result': recoverApi(savedList(), fetched()) }); await unlock(s.page); await s.page.waitForTimeout(300); await putResume(s.page);
    await s.page.fill('input[oninput*="experience\',0,\'title\'"]', 'Newer work typed after'); const before = await s.page.evaluate(() => JSON.stringify(ResumeCore.clean(state.data))); await s.page.waitForTimeout(300);
    s.page.removeAllListeners('dialog'); const questions = []; s.page.on('dialog', (d) => { questions.push(d.message()); d.dismiss(); });
    await s.page.click(`#restore-${STEP}`); await s.page.waitForTimeout(250); assert.match(questions[0] || '', /Replace what is on screen with your saved result/); assert.equal(await s.page.evaluate(() => JSON.stringify(ResumeCore.clean(state.data))), before, 'declined: unchanged');
    s.page.removeAllListeners('dialog'); s.page.on('dialog', (d) => d.accept()); await s.page.click(`#restore-${STEP}`); await s.page.waitForTimeout(300);
    assert.match(await s.page.innerText('#resume-preview'), /Assisted customers at the register/); assert.doesNotMatch(await s.page.innerText('#resume-preview'), /Newer work typed after/);
    await s.page.click('#undo-restore'); await s.page.waitForTimeout(300); assert.equal(await s.page.evaluate(() => JSON.stringify(ResumeCore.clean(state.data))), before, 'Undo restored the earlier work exactly'); assert.equal(s.errors.length, 0, s.errors.join('|')); await s.close();
  });

  await t.test('A RESULT THIS DEVICE ALREADY RECEIVED is not offered again (a normal Polish records only a short non-secret reference)', async () => {
    const s = await open({ 'verify-license': verifyOk, 'recover-result': recoverApi(savedList(), fetched()), 'polish-resume': () => ({ status: 200, json: { ...fetched().json, recovered: undefined, message: undefined, supportRef: 'R-AAAAAAAA' } }) });
    await unlock(s.page); await putResume(s.page); await s.page.evaluate(() => { Wiz.askPolish(); Wiz.doPolish(); }); await s.page.waitForFunction(() => !Wiz.polishState().busy); await s.page.waitForTimeout(200);
    const received = await s.page.evaluate(() => localStorage.getItem('fg_received_v1')); assert.match(received, /R-AAAAAAAA/); assert.equal(/FG-TEST|restored-tok|Assisted/.test(received), false, 'only a reference is kept');
    await s.page.evaluate(() => { recoverItems = []; return checkRecoverable(); }); await s.page.waitForTimeout(300); assert.equal(await s.page.isVisible('#recover-banner'), false); await s.close();
  });

  await t.test('FAILURE TO RESTORE (expired meanwhile / not found): a plain message, the offer disappears, the customer\'s screen is untouched, nothing was used', async () => {
    const gone = { status: 404, json: { error: 'We couldn’t find a saved result to restore. Results are kept for up to 24 hours after they finish.' } };
    const s = await open({ 'verify-license': verifyOk, 'recover-result': recoverApi(savedList(), gone) }); await unlock(s.page); await putResume(s.page); const before = await s.page.evaluate(() => JSON.stringify(ResumeCore.clean(state.data)));
    await s.page.waitForTimeout(300); s.page.on('dialog', (d) => d.accept()); await s.page.click(`#restore-${STEP}`); await s.page.waitForTimeout(300);
    assert.match(await s.page.innerText('#recover-banner'), /couldn’t find a saved result/); assert.doesNotMatch(await s.page.innerText('#recover-banner'), /Restore my result/); assert.equal(await s.page.evaluate(() => JSON.stringify(ResumeCore.clean(state.data))), before);
    assert.match(await s.page.innerText('#license-badge'), /5 of 5/); assert.equal(s.errors.length, 0, s.errors.join('|')); await s.close();
  });

  await t.test('NO CODE, NO OFFER: the free sample (no access code) never calls the recovery endpoint', async () => {
    const s = await open({ 'recover-result': recoverApi(savedList(), fetched()) }); await s.page.click('.gate-sample-link'); await s.page.waitForTimeout(300);
    assert.equal(calls(s, 'recover-result').length, 0); assert.equal(await s.page.isVisible('#recover-banner'), false); await s.close();
  });

  t.after(async () => { await browser.close(); server.close(); });
});
