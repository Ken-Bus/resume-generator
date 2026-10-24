// The customer's work is not lost: a reload, a phone browser discarding the tab, a lost AI reply. And the page works when browser storage is blocked.
// Endpoints are mocked and every call is recorded; nothing leaves the machine. Fictional applicants only.
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
const RESUME = { name: 'Jordan Ellis', contact: { email: 'jordan.ellis@example.com' }, summary: { tagline: '', bullets: [], skills: ['Customer service'] },
  experience: [{ title: 'Retail Associate', company: 'Fictional Maple Market', start: 'June 2023', end: 'August 2026', bullets: ['assisted customers', 'stocked shelves'] }], education: [], certifications: [], projects: [], awards: [] };
const POLISHED = JSON.parse(JSON.stringify(RESUME)); POLISHED.experience[0].bullets = ['Assisted customers at the register', 'Stocked shelves'];

test('Customer interruption scenarios (Chromium, mocked endpoints, fictional data)', async (t) => {
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


  const waitSaved = (page) => page.waitForTimeout(800);
  const restart = async (s) => { const st = await s.context.storageState(); await s.close(); return st; };
  const FIELD_NAME = 'input[oninput*="updateField(\'name\'"]';
  const paid = (s) => s.calls.filter((c) => !['verify-license', 'recover-result', 'export-resume'].includes(c.name));

  await t.test('GUIDED BUILDER interruption: answer questions, move between steps, switch to Edit Fields and back, type rapidly, then lose power mid-typing -> the browser reopens, offers "Continue", and everything saved is back; no generation is used', async () => {
    const s = await open({ 'verify-license': verifyOk, 'recover-result': () => ({ status: 200, json: { results: [], usesRemaining: 5, maxUses: 5 } }) }); await unlock(s.page);
    await s.page.click('#start-first'); await s.page.waitForSelector('#panel-guide .wiz-title');
    await s.page.fill('input[placeholder^="e.g. customer service"]', 'customer service'); await s.page.click('.wiz-next');
    await s.page.fill('input[placeholder="e.g. Taylor Rivera"]', 'Taylor Rivera'); await s.page.fill('input[placeholder="e.g. name@example.com"]', 'taylor.rivera@example.com');
    await s.page.click('.wiz-next'); await s.page.click('.wiz-choice:has-text("Not yet")'); await s.page.click('.wiz-next');
    await s.page.click('.wiz-add:has-text("Add a school")'); await s.page.fill('input[placeholder="e.g. Oakwood High School"]', 'Oakwood High School');
    await s.page.click('.wiz-dot:nth-child(2)'); await s.page.waitForTimeout(100);                                   // back to an earlier step
    await s.page.evaluate(() => switchPanel('edit')); await s.page.fill(FIELD_NAME, 'Taylor R. Rivera');             // Guided -> Edit Fields
    await s.page.evaluate(() => switchPanel('guide'));                                                               // and back
    assert.equal(await s.page.evaluate(() => state.data.name), 'Taylor R. Rivera'); assert.equal(await s.page.evaluate(() => state.data.education[0].school), 'Oakwood High School');
    await s.page.evaluate(() => switchPanel('edit')); await s.page.fill(FIELD_NAME, 'Taylor Rivera Jr'); await waitSaved(s.page);           // rapid edits settle into one saved draft
    for (let i = 0; i < 12; i++) await s.page.fill(FIELD_NAME, 'Taylor Rivera Jr ' + i);                             // rapid, then the plug is pulled: no pause, no page-hide event
    const st = await s.context.storageState();                                                                       // what the disk held at that instant
    const s2 = await open({ 'verify-license': verifyOk, 'recover-result': () => ({ status: 200, json: { results: [], usesRemaining: 5, maxUses: 5 } }) }, { storageState: st }); await unlock(s2.page);
    assert.equal(await s2.page.isVisible('#draft-banner'), true, 'the customer is offered their work, nothing is applied silently');
    assert.equal(await s2.page.evaluate(() => state.data && state.data.name), null);
    await s2.page.click('#draft-continue'); await s2.page.waitForTimeout(250);
    const got = await s2.page.evaluate(() => ({ n: state.data.name, e: state.data.contact.email, s: state.data.education[0].school }));
    assert.match(got.n, /^Taylor Rivera Jr( \d+)?$/, 'a consistent version: the last SAVED keystrokes, possibly not the last few before the power cut'); assert.equal(got.e, 'taylor.rivera@example.com'); assert.equal(got.s, 'Oakwood High School');
    assert.equal(paid(s2).length + paid(s).length, 0, 'no AI step and no generation'); assert.deepEqual(s2.errors, []); await s2.close();
  });

  await t.test('INTEGRATION after a restore: PDF and Word download with the licence, "Restore all my original wording" works on the restored result, balances are unchanged and no AI step runs', async () => {
    const s = await open({ 'verify-license': verifyOk, 'recover-result': recoverApi(savedList(), fetched()), 'export-resume': exportApi(['FG-TEST-AAAA']) }); await unlock(s.page); await putResume(s.page);   // current work on screen -> asked before replacing
    s.page.once('dialog', (d) => d.accept()); await s.page.click(`#restore-${STEP}`); await s.page.waitForTimeout(300);
    assert.match(await s.page.innerText('#resume-preview'), /Assisted customers at the register/);
    for (const [btn, ext] of [['#btn-pdf', /\.pdf$/], ['#btn-word', /\.docx$/]]) {
      const [dl] = await Promise.all([s.page.waitForEvent('download'), s.page.click(btn)]); assert.match(dl.suggestedFilename(), ext);
    }
    assert.equal(calls(s, 'export-resume').length, 2); assert.match(await s.page.innerText('#license-badge'), /4 of 5/);
    assert.equal(paid(s).length, 0, 'restoring and downloading used no AI step'); assert.deepEqual(s.errors, []);
    await s.page.evaluate(() => { Wiz.restoreAll(); }); await s.page.waitForTimeout(150);
    assert.equal(await s.page.evaluate(() => state.data.experience[0].bullets[0]), 'assisted customers', 'the customer\'s own earlier wording is back (Undo of the AI wording still works)');
    await s.close();
  });

  await t.test('SHARED COMPUTER: the saved draft and the restored result stay on this device only; "Clear this saved copy" leaves no resume text or access code in persistent storage', async () => {
    const s = await open({ 'verify-license': verifyOk, 'recover-result': recoverApi(savedList(), fetched()) }); await unlock(s.page); await s.page.click(`#restore-${STEP}`); await s.page.waitForTimeout(300); await waitSaved(s.page);
    assert.ok(await s.page.evaluate(() => localStorage.getItem('fg_draft_v2')), 'the restored result is autosaved locally');
    s.page.once('dialog', (d) => d.accept()); await s.page.evaluate(() => { setTimeout(clearSavedWork, 0); }); await s.page.waitForLoadState('load'); await s.page.waitForTimeout(600);
    const dump = await s.page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    for (const needle of ['Assisted customers', 'Jordan', 'FG-TEST-AAAA', 'restored-tok']) assert.equal(dump.includes(needle), false, `${needle} must not remain`);
    await s.close();
  });

  await browser.close(); server.close();
});
