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

test('automatic local drafts (Chromium, mocked endpoints, fictional data)', async (t) => {
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

  const DRAFT = 'fg_draft_v2';
  const draftOf = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), DRAFT);
  const typeTitle = async (page, v) => { await page.fill('input[oninput*="experience\',0,\'title\'"]', v); };
  const waitSaved = (page) => page.waitForTimeout(800);
  // A browser restart: local storage survives, session storage (this tab's) does not.
  const restart = async (s) => { const state = await s.context.storageState(); await s.close(); return state; };

  await t.test('SAVES AUTOMATICALLY after a pause, to this device only: the draft holds the resume and where the customer was, and NEVER an access code, a Tailor authorisation or a request id', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page); await putResume(s.page);
    await s.page.evaluate(() => { state.tailorToken = 'secret-tailor-token-123'; state.pending = { fn: 'polish', requestId: 'req-id-secret-1', at: Date.now() }; });
    await typeTitle(s.page, 'Shift Lead'); await waitSaved(s.page);
    const raw = await s.page.evaluate((k) => localStorage.getItem(k), DRAFT); assert.ok(raw, 'a draft was saved'); const d = JSON.parse(raw);
    assert.equal(d.data.experience[0].title, 'Shift Lead'); assert.ok(d.rev >= 1 && d.savedAt && d.tab);
    for (const secret of ['FG-TEST-AAAA', 'secret-tailor-token-123', 'req-id-secret-1', 'tailorToken', 'pending']) assert.equal(raw.includes(secret), false, `the draft must not contain ${secret}`);
    const all = await s.page.evaluate(() => JSON.stringify({ l: { ...localStorage } })); assert.equal(all.includes('FG-TEST-AAAA') || all.includes('secret-tailor-token-123'), false, 'nothing credential-like is in persistent storage');
    assert.match(await s.page.innerText('#save-status'), /Progress saved on this device\./); assert.equal(s.calls.filter((c) => c.name !== 'verify-license').length, 0, 'saving made no server call and used no generation');
    await s.close();
  });

  await t.test('FLUSH when the page is hidden: a change made less than half a second ago is still saved the moment the tab is hidden or closed', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page); await putResume(s.page); await waitSaved(s.page);
    await typeTitle(s.page, 'Hidden Flush Title');
    await s.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal((await draftOf(s.page)).data.experience[0].title, 'Hidden Flush Title'); await s.close();
  });

  await t.test('RESTART (local storage kept, session storage gone): nothing is applied silently; the customer is offered "Continue where I left off", and gets everything back, including the Guided Builder step, without using a generation', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page);
    await s.page.evaluate(() => { startGuided('first'); }); await s.page.waitForTimeout(200);
    await s.page.evaluate(() => { Wiz.set('name', 'Taylor Rivera'); Wiz.next(); Wiz.next(); }); await waitSaved(s.page);
    const stepBefore = await s.page.evaluate(() => state.wizard.step); assert.ok(stepBefore >= 1);
    const st = await restart(s);
    const s2 = await open({ 'verify-license': verifyOk }, { storageState: st }); await unlock(s2.page);
    assert.equal(await s2.page.evaluate(() => !!(state.data && state.data.name)), false, 'not applied silently');
    assert.equal(await s2.page.isVisible('#draft-banner'), true); const bt = await s2.page.innerText('#draft-banner');
    assert.match(bt, /unfinished resume saved on this device/); assert.match(bt, /Taylor Rivera/); assert.match(bt, /Continue where I left off/i); assert.match(bt, /never uploaded/); assert.match(bt, /shared computer/i); assert.match(bt, /14 days/); assert.match(bt, /power loss/);
    await s2.page.click('#draft-continue'); await s2.page.waitForTimeout(250);
    assert.equal(await s2.page.evaluate(() => state.data.name), 'Taylor Rivera'); assert.equal(await s2.page.evaluate(() => state.wizard && state.wizard.step), stepBefore, 'the Guided Builder is on the same step');
    assert.equal(await s2.page.isVisible('#draft-banner'), false); assert.match(await s2.page.innerText('#license-badge'), /5 of 5/);
    assert.equal(s2.calls.filter((c) => c.name !== 'verify-license').length, 0, 'restoring made no AI call and used no generation'); assert.equal(s2.errors.length, 0, s2.errors.join('|'));
    await s2.close();
  });

  await t.test('EDITS AFTER ANALYZE / POLISH are kept: the polished wording, the customer\'s later edit and the Restore baseline all come back', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page); await putResume(s.page);
    await s.page.evaluate(() => { state.polishBaseline = ResumeCore.clean(state.data); state.polishOriginal = ResumeCore.clean(state.data); state.data.experience[0].bullets = ['Assisted customers at the register', 'Stocked shelves']; state.polishResult = ResumeCore.clean(state.data); renderEditFields(); renderPreview(); });
    await typeTitle(s.page, 'Edited after the polish'); await waitSaved(s.page); const st = await restart(s);
    const s2 = await open({ 'verify-license': verifyOk }, { storageState: st }); await unlock(s2.page); await s2.page.click('#draft-continue'); await s2.page.waitForTimeout(250);
    const got = await s2.page.evaluate(() => ({ t: state.data.experience[0].title, b: state.data.experience[0].bullets[0], base: state.polishBaseline.experience[0].bullets[0], res: !!state.polishResult }));
    assert.deepEqual(got, { t: 'Edited after the polish', b: 'Assisted customers at the register', base: 'assisted customers', res: true }); await s2.close();
  });

  await t.test('DISCARD: after confirming, the saved draft is gone from the device, the page starts fresh, and a reload offers nothing; declining the question keeps it', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page); await putResume(s.page); await waitSaved(s.page); const st = await restart(s);
    const s2 = await open({ 'verify-license': verifyOk }, { storageState: st }); await unlock(s2.page);
    s2.page.removeAllListeners('dialog'); s2.page.once('dialog', (d) => d.dismiss()); await s2.page.click('#draft-discard'); assert.ok(await draftOf(s2.page), 'declined: still saved'); assert.equal(await s2.page.isVisible('#draft-banner'), true);
    s2.page.once('dialog', (d) => d.accept()); await s2.page.click('#draft-discard'); await s2.page.waitForTimeout(200);
    assert.equal(await draftOf(s2.page), null); assert.equal(await s2.page.isVisible('#draft-banner'), false);
    await s2.page.reload(); await s2.page.waitForTimeout(300); assert.equal(await s2.page.isVisible('#draft-banner'), false); await s2.close();
  });

  await t.test('NEVER OVERWRITES: a customer who starts typing a NEW resume before choosing cannot silently replace the older saved draft; the page says so, and only an explicit choice replaces it', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page); await putResume(s.page); await typeTitle(s.page, 'OLD SAVED DRAFT'); await waitSaved(s.page); const st = await restart(s);
    const s2 = await open({ 'verify-license': verifyOk }, { storageState: st }); await unlock(s2.page);
    await s2.page.evaluate(() => { state.data = { name: 'Brand New Person', contact: {}, summary: { tagline: '', bullets: [], skills: [] }, experience: [{ title: 'New Job', company: 'New Co', start: '', end: '', bullets: ['did a thing'] }], education: [], certifications: [], projects: [], volunteer: [], awards: [] }; renderEditFields(); renderPreview(); }); await waitSaved(s2.page);
    assert.equal((await draftOf(s2.page)).data.experience[0].title, 'OLD SAVED DRAFT', 'the older draft is untouched'); assert.match(await s2.page.innerText('#save-status'), /Not saved/);
    await s2.page.click('#save-status button'); await s2.page.waitForTimeout(200); assert.equal((await draftOf(s2.page)).data.name, 'Brand New Person', 'only after the explicit choice'); assert.match(await s2.page.innerText('#save-status'), /Progress saved on this device/);
    await s2.close();
  });

  await t.test('TWO WINDOWS: an idle window never writes; a window whose copy is older than what another window saved stops saving instead of overwriting', async () => {
    const ctx = await browser.newContext(); const a = await open({ 'verify-license': verifyOk }, { ctx }); await unlock(a.page); await putResume(a.page); await typeTitle(a.page, 'Window A v1'); await waitSaved(a.page);
    const b = await open({ 'verify-license': verifyOk }, { ctx }); await unlock(b.page); await b.page.click('#draft-continue'); await b.page.waitForTimeout(250);
    const revBefore = (await draftOf(b.page)).rev; await b.page.waitForTimeout(1200); assert.equal((await draftOf(b.page)).rev, revBefore, 'window B changed nothing, so it wrote nothing');
    await typeTitle(b.page, 'Window B newer'); await waitSaved(b.page); assert.equal((await draftOf(b.page)).data.experience[0].title, 'Window B newer');
    await typeTitle(a.page, 'Window A stale edit'); await waitSaved(a.page);
    assert.equal((await draftOf(a.page)).data.experience[0].title, 'Window B newer', 'window A\'s older copy did not overwrite B\'s newer work'); assert.match(await a.page.innerText('#save-status'), /another window/);
    await ctx.close();
  });

  await t.test('STORAGE FAILURES: full or blocked storage never crashes the page and never claims a save that did not happen (tab-only fallback is labelled; total failure says "download your resume")', async () => {
    const quota = () => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (this === window.localStorage && k === 'fg_draft_v2') throw new DOMException('full', 'QuotaExceededError'); return orig.call(this, k, v); }; };
    const s = await open({ 'verify-license': verifyOk }, { initScript: quota }); await unlock(s.page); await putResume(s.page); await typeTitle(s.page, 'No room'); await waitSaved(s.page);
    assert.equal(await s.page.evaluate((k) => localStorage.getItem(k), DRAFT), null); assert.match(await s.page.innerText('#save-status'), /Saved in this tab only/); assert.doesNotMatch(await s.page.innerText('#save-status'), /Progress saved on this device/);
    assert.equal(s.errors.length, 0, s.errors.join('|')); await s.close();
    const both = () => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'fg_draft_v2') throw new DOMException('full', 'QuotaExceededError'); return orig.call(this, k, v); }; };
    const s2 = await open({ 'verify-license': verifyOk }, { initScript: both }); await unlock(s2.page); await putResume(s2.page); await typeTitle(s2.page, 'Nowhere to save'); await waitSaved(s2.page);
    const txt = await s2.page.innerText('#save-status'); assert.match(txt, /Couldn’t save on this device/); assert.match(txt, /download your resume/); assert.doesNotMatch(txt, /Saved on this device|Saved in this tab/);
    await typeTitle(s2.page, 'Still editing'); assert.match(await s2.page.innerText('#resume-preview'), /Still editing/); assert.equal(s2.errors.length, 0, s2.errors.join('|')); await s2.close();
    const blocked = () => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('insecure', 'SecurityError'); } }); };
    const s3 = await open({ 'verify-license': verifyOk }, { initScript: blocked }); await unlock(s3.page); await putResume(s3.page); await typeTitle(s3.page, 'localStorage blocked'); await waitSaved(s3.page);
    assert.match(await s3.page.innerText('#save-status'), /Saved in this tab only/); assert.equal(s3.errors.length, 0, s3.errors.join('|')); await s3.close();
  });

  await t.test('OLD DRAFTS EXPIRE: a draft older than 14 days is ignored and not offered (shared computers); a fresh one is', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page); await putResume(s.page); await waitSaved(s.page);
    await s.page.evaluate((k) => { const d = JSON.parse(localStorage.getItem(k)); d.savedAt = Date.now() - 15 * 24 * 3600 * 1000; d.tab = 'someone-else'; localStorage.setItem(k, JSON.stringify(d)); }, DRAFT);
    const st = await restart(s); const s2 = await open({ 'verify-license': verifyOk }, { storageState: st }); await unlock(s2.page);
    assert.equal(await s2.page.isVisible('#draft-banner'), false); assert.equal(s2.errors.length, 0, s2.errors.join('|')); await s2.close();
  });

  await t.test('A damaged or foreign saved value is ignored without a crash (an older build\'s tab draft is imported once)', async () => {
    const s = await open({ 'verify-license': verifyOk }); await s.page.evaluate((k) => { localStorage.setItem(k, '{broken'); }, DRAFT); await s.page.reload(); await s.page.waitForTimeout(300);
    assert.equal(s.errors.length, 0, s.errors.join('|')); assert.equal(await s.page.isVisible('#draft-banner'), false);
    const legacy = { v: 1, savedAt: Date.now(), data: { name: 'Legacy Person', contact: {}, summary: { tagline: 'x', bullets: [], skills: [] }, experience: [{ title: 'Old', company: 'Co', start: '', end: '', bullets: ['a line'] }], education: [], certifications: [], projects: [], volunteer: [], awards: [] }, template: 'boardroom', alt: false, panel: 'edit', flags: [], tailorToken: 'legacy-token-1', pending: null, wizard: null, resumeText: '', jobText: '' };
    await s.page.evaluate(([k, v]) => { localStorage.removeItem('fg_draft_v2'); sessionStorage.setItem(k, v); }, ['fg_work_v1', JSON.stringify(legacy)]); await s.page.reload(); await s.page.waitForTimeout(400);
    assert.equal(await s.page.evaluate(() => state.data && state.data.name), 'Legacy Person'); assert.equal(await s.page.evaluate(() => sessionStorage.getItem('fg_work_v1')), null);
    await s.page.waitForTimeout(800); assert.equal((await s.page.evaluate((k) => localStorage.getItem(k), DRAFT)).includes('legacy-token-1'), false, 'the old token was not carried into persistent storage'); await s.close();
  });

  await t.test('A refresh of the SAME tab restores without any prompt; "Clear this saved copy" removes the draft, the code and the tab keys from the device', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page); await putResume(s.page); await typeTitle(s.page, 'Refresh me'); await waitSaved(s.page);
    await s.page.reload(); await s.page.waitForTimeout(400); assert.equal(await s.page.isVisible('#draft-banner'), false); assert.match(await s.page.innerText('#resume-preview'), /Refresh me/); assert.match(await s.page.innerText('#restore-notice'), /Welcome back/);
    s.page.removeAllListeners('dialog'); s.page.once('dialog', (d) => d.accept()); await Promise.all([s.page.waitForNavigation(), s.page.click('#restore-notice button')]); await s.page.waitForTimeout(300);
    const left = await s.page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } })); assert.equal(/fg_draft_v2|fg_license|FG-TEST/.test(left), false, left); await s.close();
  });

  await t.test('UNEXPECTED CLOSE: typing and the chosen template are saved by the time the tab is killed (no close event runs); a new tab offers the draft and restores every field and the template; "Progress saved" is shown only after the write succeeded', async () => {
    const s = await open({ 'verify-license': verifyOk }); await unlock(s.page); await putResume(s.page);
    assert.equal(await s.page.innerText('#save-status'), '', 'nothing is claimed before anything was saved');
    await s.page.evaluate(() => { selectCategory('Trades'); selectTemplate('operator'); });
    await typeTitle(s.page, 'Shift Lead'); await s.page.fill('input[oninput*="experience\',0,\'company\'"]', 'Maple Market Two'); await waitSaved(s.page);
    assert.match(await s.page.innerText('#save-status'), /^Progress saved on this device\./);
    await s.page.close({ runBeforeUnload: false });                                                        // the browser or the tab dies: nothing gets to run
    const page2 = await s.context.newPage(); await page2.route('**/*', (route) => (route.request().url().includes('/.netlify/functions/') ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, usesRemaining: 5, maxUses: 5 }) }) : route.request().url().startsWith(base) ? route.continue() : route.abort()));
    await page2.goto(base + '/index.html'); await unlock(page2); await page2.waitForSelector('#draft-banner', { state: 'visible' });
    assert.equal(await page2.evaluate(() => !!(state.data && state.data.name)), false, 'not applied silently');
    await page2.click('#draft-continue'); await page2.waitForTimeout(250);
    const got = await page2.evaluate(() => ({ title: state.data.experience[0].title, company: state.data.experience[0].company, name: state.data.name, tpl: state.selectedTemplate.id, cat: state.selectedCategory, tab: document.querySelector('.category-tab.active').textContent.trim(), skills: state.data.summary.skills }));
    assert.deepEqual(got, { title: 'Shift Lead', company: 'Maple Market Two', name: 'Jordan Ellis', tpl: 'operator', cat: 'Trades', tab: 'Labor & Trades', skills: ['Customer service'] });
    await s.close();
  });

  t.after(async () => { await browser.close(); server.close(); });
});
