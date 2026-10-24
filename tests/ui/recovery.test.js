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

test('recovery experience (Chromium, mocked endpoints): what the customer sees and can do next', async (t) => {
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
        if (name !== 'recover-result') calls.push({ name, body });
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

  const PRESS = async (s) => { await s.page.evaluate(() => { Wiz.askPolish(); }); await s.page.evaluate(() => Wiz.doPolish()); await s.page.waitForFunction(() => !Wiz.polishState().busy); await s.page.waitForTimeout(120); };
  const rid = (s) => s.page.evaluate(() => Wiz.polishState().requestId);
  const text = (s) => s.page.innerText('body');
  const okBody = (extra = {}) => ({ status: 200, json: { guard: 'x', result: JSON.stringify(POLISHED), unverified: [], withheld: [], changes: { reworded: 1, minor: 0, cosmetic: 0, unchanged: 0, dropped: 0 }, points: 3, threshold: 3, charged: true, usesRemaining: 4, maxUses: 5, tailorToken: 'tok', ...extra } });
  const refused = (code, error, extra = {}) => ({ status: 409, json: { code, error, newRequest: true, supportRef: 'R-1A2B3C4D', usesRemaining: 4, maxUses: 5, ...extra } });

  await t.test('RECOVERED (regenerated): the customer is told plainly it is a fresh version, that it was already counted, nothing more is used, and Restore still returns their own wording', async () => {
    const msg = 'Your earlier step was completed and counted, but its result did not reach you. We prepared a fresh version for the same resume, so the wording may differ from the first one. No additional generation was used.';
    const s = await open({ 'verify-license': verifyOk, 'polish-resume': () => okBody({ recovered: 'regenerated', message: msg, supportRef: 'R-1A2B3C4D' }) }); await unlock(s.page); await putResume(s.page);
    await PRESS(s); const t0 = await text(s);
    assert.match(t0, /Your earlier result was recovered/); assert.match(t0, /fresh version for the same resume/); assert.match(t0, /may differ/); assert.match(t0, /No additional generation was used/); assert.match(t0, /Reference: R-1A2B3C4D/);
    assert.doesNotMatch(t0, /That used 1 generation/, 'it does not claim this attempt used a generation'); assert.match(await s.page.innerText('#license-badge'), /4 of 5/);
    assert.match(await s.page.innerText('#resume-preview'), /Assisted customers at the register/);
    await s.page.evaluate(() => Wiz.restoreAll()); assert.match(await s.page.innerText('#resume-preview'), /assisted customers/i); assert.equal(s.errors.length, 0, s.errors.join('|'));
    await s.close();
  });

  await t.test('RECOVERED (exact): "Your earlier result is back", no regeneration claim', async () => {
    const s = await open({ 'verify-license': verifyOk, 'polish-resume': () => okBody({ recovered: 'exact', message: 'Your earlier result has been restored exactly as it was. No additional generation was used.' }) }); await unlock(s.page); await putResume(s.page);
    await PRESS(s); const t0 = await text(s); assert.match(t0, /Your earlier result is back/); assert.match(t0, /exactly as it was/); assert.doesNotMatch(t0, /fresh version/); await s.close();
  });

  for (const [code, error, label] of [
    ['request_conflict', 'Your resume has changed since an earlier polish that may already have been completed and counted. Nothing was charged just now and your resume is unchanged. Please check the generations counter, then press the button again to start a new polish of your current resume. If a generation looks wrong, message us with this reference: R-1A2B3C4D (never your access code or your resume).', 'EDITED AFTER A POSSIBLY-PAID STEP'],
    ['request_expired', 'That earlier polish is more than a day old, so its result can no longer be recovered here. Nothing was charged just now. Please check the generations counter, then press the button again to start a new polish.', 'A STALE REQUEST'],
    ['recovery_limit', 'Your earlier polish was completed and counted, but its result did not reach you after several tries. Nothing more has been charged and your resume is unchanged. Please message us with this reference: R-1A2B3C4D (never your access code or your resume) and we will put it right. You can also press the button again to start a new polish.', 'RECOVERY LIMIT REACHED'],
  ]) {
    await t.test(`${label}: the message is shown plainly, the resume is untouched, nothing is retried automatically, the old id is dropped, and the NEXT deliberate press sends a brand-new id`, async () => {
      let n = 0; const s = await open({ 'verify-license': verifyOk, 'polish-resume': () => (++n === 1 ? refused(code, error) : okBody()) }); await unlock(s.page); await putResume(s.page);
      await s.page.evaluate(() => { Wiz.polishState().requestId = 'spent-id-0001'; state.pending = { fn: 'polish', requestId: 'spent-id-0001', at: Date.now() }; });
      const before = await s.page.evaluate(() => JSON.stringify(ResumeCore.clean(state.data)));
      await PRESS(s); const t1 = await text(s);
      assert.match(t1, new RegExp(error.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); if (/R-1A2B3C4D/.test(error)) assert.match(t1, /R-1A2B3C4D/);
      assert.doesNotMatch(t1, /FG-TEST-AAAA/, 'the access code is never shown'); assert.equal(s.calls.filter((c) => c.name === 'polish-resume').length, 1, 'no automatic retry');
      assert.equal(await s.page.evaluate(() => JSON.stringify(ResumeCore.clean(state.data))), before, 'the resume is exactly as the customer left it');
      assert.equal(await rid(s), null, 'the spent id was dropped'); assert.equal(await s.page.evaluate(() => state.pending), null);
      await PRESS(s); const sent = s.calls.filter((c) => c.name === 'polish-resume'); assert.equal(sent.length, 2); assert.notEqual(sent[1].body.requestId, 'spent-id-0001', 'a new operation gets a new id');
      assert.match(await s.page.innerText('#license-badge'), /4 of 5/); assert.equal(s.errors.length, 0, s.errors.join('|')); await s.close();
    });
  }

  await t.test('RECOVERY FAILED (AI busy during recovery): honest message, the SAME id is kept for the next try, the customer\'s edits are untouched, and the try after that recovers', async () => {
    let n = 0; const s = await open({ 'verify-license': verifyOk, 'polish-resume': (b) => (++n === 1 ? { status: 502, json: { code: 'recovery_failed', supportRef: 'R-1A2B3C4D', error: 'Your earlier polish was completed and counted, and nothing more has been charged. The AI service is very busy right now, so we could not prepare its result. Please wait a minute or two and try again. Your resume is unchanged.' } } : (() => { const o = JSON.parse(JSON.stringify(b.resume)); o.experience[0].bullets = ['Assisted customers at the register', 'Stocked shelves']; return okBody({ result: JSON.stringify(o), recovered: 'regenerated', message: 'fresh', supportRef: 'R-1A2B3C4D' }); })()) });
    await unlock(s.page); await putResume(s.page);
    await s.page.fill('input[oninput*="experience\',0,\'title\'"]', 'Edited title kept'); await s.page.evaluate(() => { Wiz.polishState().requestId = 'paid-step-id-1'; });
    await PRESS(s); assert.match(await text(s), /completed and counted, and nothing more has been charged/); assert.equal(await rid(s), 'paid-step-id-1', 'the paid step keeps its id so it can still be recovered');
    assert.match(await s.page.innerText('#resume-preview'), /Edited title kept/);
    await PRESS(s); const sent = s.calls.filter((c) => c.name === 'polish-resume'); assert.equal(sent[1].body.requestId, 'paid-step-id-1'); assert.match(await text(s), /Your earlier result was recovered/); await s.close();
  });

  await t.test('ANALYZE: a recovered analysis is labelled; a refusal that asks for a new request drops the id and shows the message', async () => {
    const goodParse = (extra) => ({ status: 200, json: { result: JSON.stringify(RESUME), unverified: [], usesRemaining: 4, maxUses: 5, tailorToken: 't', ...extra } });
    let n = 0; const s = await open({ 'verify-license': verifyOk, 'parse-resume': () => (++n === 1 ? refused('request_conflict', 'Your resume has changed since an earlier analysis that may already have been completed and counted. Nothing was charged just now. Please press the button again.') : goodParse({ recovered: 'regenerated', message: 'Your earlier step was completed and counted, but its result did not reach you. We prepared a fresh version.', supportRef: 'R-1A2B3C4D' })) });
    await unlock(s.page); await s.page.evaluate(() => switchPanel('paste')); await s.page.fill('#resume-input', 'Jordan Ellis. Retail Associate at Fictional Maple Market, June 2023 to August 2026. Assisted customers and stocked shelves.');
    await s.page.click('#parse-btn'); await s.page.waitForFunction(() => !state.aiBusy); await s.page.waitForTimeout(150);
    assert.match(await s.page.innerText('#error-box'), /has changed since an earlier analysis/); assert.equal(await s.page.evaluate(() => state.pending), null, 'the spent id was dropped');
    await s.page.click('#parse-btn'); await s.page.waitForFunction(() => state.data && state.data.name === 'Jordan Ellis'); await s.page.waitForTimeout(150);
    const calls = s.calls.filter((c) => c.name === 'parse-resume'); assert.equal(calls.length, 2); assert.notEqual(calls[0].body.requestId, calls[1].body.requestId);
    assert.match(await text(s), /Your earlier result was recovered/); assert.match(await text(s), /Reference: R-1A2B3C4D/); assert.equal(s.errors.length, 0, s.errors.join('|')); await s.close();
  });

  await t.test('STORAGE / TAB: a recovery refusal is not stored as a pending step, so a reload does not resurrect a spent id', async () => {
    const s = await open({ 'verify-license': verifyOk, 'polish-resume': () => refused('request_expired', 'That earlier polish is more than a day old.') }); await unlock(s.page); await putResume(s.page);
    await PRESS(s); await s.page.waitForTimeout(400); await reload(s); assert.equal(await rid(s), null); assert.equal(await s.page.evaluate(() => state.pending), null); await s.close();
  });

  await browser.close(); server.close();
});
