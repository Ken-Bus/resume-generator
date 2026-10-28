// What the customer sees and what the page sends: the charge is explained BEFORE an AI action, an included Polish is shown as included (even at zero
// generations), restoring wording works and is honest about what stays used, the four-day completion notice and the save reminders appear only when
// they apply. Real index.html in headless Chromium; every endpoint is mocked; nothing is paid. Fictional customers only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { PW, CHROME, unavailable } = require('./browser');
const { exportApi, setAccessStates } = require('./export-api');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const GOOD = 'FG-TEST-AAAA';

const ORIGINAL = { name: 'Maria Delgado', contact: { phone: '', email: 'maria.delgado@example.com', location: 'Columbus, OH', linkedin: '', website: '' },
  summary: { tagline: 'Warehouse associate', bullets: [], skills: ['Teamwork'] },
  experience: [{ title: 'Warehouse Associate', company: 'Fictional Freight Co', location: 'Columbus, OH', start: '2019', end: 'Present', summary: '', bullets: ['loaded trucks', 'counted stock every week'] }],
  education: [{ degree: 'High School Diploma', school: 'Central High School', location: '', date: '2018', honors: '' }], certifications: [], projects: [], volunteer: [], awards: [] };
const POLISHED = JSON.parse(JSON.stringify(ORIGINAL)); POLISHED.experience[0].bullets = ['Loaded trucks at the dock', 'Counted stock every week'];

const serve = () => new Promise((r) => {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  server.listen(0, '127.0.0.1', () => r(server));
});

test('included polish, charge explanations, four-day notice and save reminders (Chromium, mocked endpoints)', async (t) => {
  if (unavailable(t)) return;
  const { chromium } = require(PW);
  const server = await serve(); const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME });

  // The account as the server would report it; the mocks below change it the way the real server does.
  const newAcct = (o = {}) => ({ left: 5, credit: 0, state: 'active', until: null, valid: true, ...o });
  const verifyFor = (a) => (b) => (b && b.code === GOOD
    ? (a.valid === false ? { status: 200, json: { valid: false, accessState: 'ended', error: 'The four-day finishing period for this code has ended, and it has no AI generations left.', usesRemaining: 0, maxUses: 5 } }
      : { status: 200, json: { valid: true, usesRemaining: a.left, maxUses: 5, includedAvailable: a.credit, accessState: a.state, accessUntil: a.until } })
    : { status: 200, json: { valid: false, error: 'We couldn’t find that code.' } });
  const polishFor = (a) => (body) => {
    if (body && body.expectIncluded && a.credit < 1) return { status: 409, json: { error: 'Your included AI Polish is no longer available (it may have been used in another window). Nothing was used. Please check your counter, then choose Polish again to continue.', code: 'included_unavailable', newRequest: true, usesRemaining: a.left, maxUses: 5 } };
    if (a.credit > 0) { a.credit -= 1; return { status: 200, json: { result: JSON.stringify(POLISHED), usesRemaining: a.left, maxUses: 5, tailorToken: 'tok-parent', unverified: [], withheld: [], changes: { reworded: 1, minor: 0, cosmetic: 0, unchanged: 1, dropped: 0 }, charged: false, included: true } }; }
    a.left -= 1; return { status: 200, json: { result: JSON.stringify(POLISHED), usesRemaining: a.left, maxUses: 5, tailorToken: 'tok-paid', unverified: [], withheld: [], changes: { reworded: 1, minor: 0, cosmetic: 0, unchanged: 1, dropped: 0 }, charged: true } };
  };
  async function open(a, extra = {}, opts = {}) {
    const ctx = opts.ctx || await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage(); const calls = []; const errors = [];
    page.on('pageerror', (e) => errors.push(String(e))); page.on('dialog', (d) => d.accept());
    const api = { 'verify-license': verifyFor(a), 'export-resume': exportApi([GOOD]), ...extra };
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.includes('/.netlify/functions/')) {
        const name = url.split('/.netlify/functions/')[1]; let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (e) {}
        if (name !== 'recover-result') calls.push({ name, body });
        const r = await (api[name] || (() => ({ status: 500, json: { error: 'unmocked' } })))(body, calls.filter((c) => c.name === name).length);
        if (r.raw) return route.fulfill({ status: r.status, headers: r.headers, body: Buffer.from(r.body || '', r.isBase64Encoded ? 'base64' : 'utf8') });
        return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.json) });
      }
      return url.startsWith(base) ? route.continue() : route.abort();
    });
    await page.goto(base + '/index.html');
    return { page, ctx, calls, errors, close: () => ctx.close() };
  }
  const unlock = async (s) => { await s.page.fill('#gate-code-input', GOOD); await s.page.click('#gate-unlock-btn'); await s.page.waitForTimeout(300); };
  const withResume = (s) => s.page.evaluate((x) => { state.data = JSON.parse(JSON.stringify(x)); renderEditFields(); renderPreview(); switchPanel('edit'); }, ORIGINAL);
  const polishCalls = (s) => s.calls.filter((c) => c.name === 'polish-resume');
  const card = (s) => s.page.innerText('#edit-polish');

  await t.test('BEFORE the click: the paste screen says what Analyze costs and what it keeps; at zero generations it says Analyze is not available', async () => {
    const a = newAcct(); const s = await open(a);
    assert.match(await s.page.innerText('.paste-hint'), /keeps your spelling and wording exactly as you wrote it/);
    assert.match(await s.page.innerText('#analyze-cost'), /Analyze Resume uses 1 of your AI generations and includes one free AI Polish afterwards/);
    await s.close();
    const z = newAcct({ left: 0, credit: 1 }); const s2 = await open(z); await unlock(s2);
    const t2 = await s2.page.innerText('#analyze-cost'); assert.match(t2, /no generations left, so Analyze is not available/); assert.match(t2, /included AI Polish/);
    assert.match(await s2.page.innerText('#license-badge'), /0 of 5/); await s2.close();
  });

  await t.test('INCLUDED: the card says so and that no generation is used; one click only asks; the request says the page expected an included Polish; the result is honest', async () => {
    const a = newAcct({ left: 4, credit: 1 }); const s = await open(a, { 'polish-resume': polishFor(a) }); await unlock(s); await withResume(s);
    const c = await card(s);
    assert.match(c, /Polish My Resume with AI \(included\)/); assert.match(c, /Included with your analysis, so it uses no generation/); assert.match(c, /If you restore your own wording afterwards, it stays used/);
    await s.page.click('#edit-polish-btn');
    const conf = await s.page.innerText('#edit-polish .wiz-confirm');
    assert.match(conf, /Your included polish is used only if it rewrites some of your wording or corrects three or more mistakes/); assert.match(conf, /no generation is used/i);
    assert.equal(polishCalls(s).length, 0, 'nothing is sent until the second click');
    await s.page.click('#edit-polish-confirm'); await s.page.waitForSelector('#edit-polish .wiz-ok');
    const sent = polishCalls(s); assert.equal(sent.length, 1); assert.equal(sent[0].body.expectIncluded, true);
    const done = await s.page.innerText('#edit-polish .wiz-ok');
    assert.match(done, /That used your included polish, so no generation was used \(4 of 5 left\)/); assert.match(done, /Your resume has been updated\. Download a copy to keep your work safe\./);
    assert.match(done, /Restoring your own wording does not give back your included polish/);
    assert.match(await s.page.innerText('#license-badge'), /4 of 5/); assert.equal(await s.page.evaluate(() => state.tailorToken), 'tok-parent');
    await s.close();
  });

  await t.test('RESTORE after an included Polish brings back the customer\'s own wording, and the NEXT Polish is shown (and sent) as a paid one', async () => {
    const a = newAcct({ left: 4, credit: 1 }); const s = await open(a, { 'polish-resume': polishFor(a) }); await unlock(s); await withResume(s);
    await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); await s.page.waitForSelector('#edit-polish .wiz-ok');
    assert.deepEqual(await s.page.evaluate(() => state.data.experience[0].bullets), ['Loaded trucks at the dock', 'Counted stock every week']);
    await s.page.click('#edit-polish button:has-text("Restore all my original wording")');
    assert.deepEqual(await s.page.evaluate(() => state.data.experience[0].bullets), ['loaded trucks', 'counted stock every week'], 'the original wording is back');
    assert.equal(a.credit, 0, 'and the included Polish stays used');
    const after = await card(s);
    assert.doesNotMatch(after, /\(included\)/); assert.match(after, /Uses 1 of your 4 generations/); assert.match(after, /If you restore your own wording afterwards, that generation stays used, and a second meaningful polish uses another generation/);
    await s.page.click('#edit-polish-btn'); assert.match(await s.page.innerText('#edit-polish .wiz-confirm'), /that uses 1 of your 4 generations remaining/);
    await s.page.click('#edit-polish-confirm'); await s.page.waitForSelector('#edit-polish .wiz-ok');
    assert.equal(polishCalls(s)[1].body.expectIncluded, false); assert.match(await s.page.innerText('#license-badge'), /3 of 5/);
    assert.match(await s.page.innerText('#edit-polish .wiz-ok'), /That used 1 generation \(3 of 5 left\)/); await s.close();
  });

  await t.test('NO included Polish (for example a Guided Builder customer): the charge and the restore rule are stated before the click', async () => {
    const a = newAcct({ left: 5, credit: 0 }); const s = await open(a, { 'polish-resume': polishFor(a) }); await unlock(s); await withResume(s);
    const c = await card(s); assert.match(c, /Uses 1 of your 5 generations \(of 5\) only if the AI rewrites some of your wording or corrects three or more mistakes/);
    assert.match(c, /If you restore your own wording afterwards, that generation stays used, and a second meaningful polish uses another generation/); assert.doesNotMatch(c, /included/i);
    await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); await s.page.waitForSelector('#edit-polish .wiz-ok');
    assert.equal(polishCalls(s)[0].body.expectIncluded, false); assert.match(await s.page.innerText('#edit-polish .wiz-ok'), /Restoring your own wording does not give back the generation/); await s.close();
  });

  await t.test('ZERO GENERATIONS with an included Polish: signed in, the Polish is offered as included, and the customer is told it is the last AI step and the four-day period follows', async () => {
    const a = newAcct({ left: 0, credit: 1 }); const s = await open(a, { 'polish-resume': polishFor(a) }); await unlock(s); await withResume(s);
    assert.match(await s.page.innerText('#license-badge'), /0 of 5/);
    const n = await s.page.innerText('#access-notice'); assert.match(n, /You have no generations left, but your included AI Polish is still available/); assert.match(n, /four days to finish editing and download/);
    assert.equal(await s.page.isVisible('#access-notice'), true);
    const c = await card(s); assert.match(c, /\(included\)/); assert.match(c, /Using it is your last AI step: you will then have four days/); assert.doesNotMatch(c, /You’ve used all/);
    await s.page.click('#edit-polish-btn'); assert.match(await s.page.innerText('#edit-polish .wiz-confirm'), /This is your last AI step: you will then have four days/);
    await s.close();
  });

  await t.test('ZERO GENERATIONS and nothing included: the old "used all" message, no included button, and no four-day notice unless the completion period applies', async () => {
    const a = newAcct({ left: 0, credit: 0, state: 'ended' }); a.state = 'active';                    // a server never sends this combination as active; the page must not invent a notice
    const s = await open(a); await unlock(s); await withResume(s);
    assert.match(await card(s), /You’ve used all 5 generations on this code/); assert.equal(await s.page.isVisible('#access-notice'), false); await s.close();
  });

  await t.test('FOUR-DAY NOTICE: shown only during the completion period, with the end time and the save advice; never when generations remain; not repeated as a pop-up', async () => {
    const until = new Date(Date.now() + 90 * 3600 * 1000).toISOString();
    const a = newAcct({ left: 0, credit: 0, state: 'completion', until }); const s = await open(a); await unlock(s); await withResume(s);
    const n = await s.page.innerText('#access-notice');
    assert.match(n, /You have four days to finish editing and download your resume\./); assert.match(n, /Save both Word and PDF copies to your computer, USB drive, or another safe location\./); assert.match(n, /Your access ends/);
    assert.equal(await s.page.locator('#access-notice').count(), 1); await s.close();
    const b = newAcct({ left: 3 }); const s2 = await open(b); await unlock(s2); await withResume(s2);
    assert.equal(await s2.page.isVisible('#access-notice'), false); await s2.close();
  });

  await t.test('AFTER THE LAST BENEFIT is used the page picks up the completion period without a reload', async () => {
    const a = newAcct({ left: 0, credit: 1 }); const s = await open(a, { 'polish-resume': () => { const r = polishFor(a)(); a.state = 'completion'; a.until = new Date(Date.now() + 96 * 3600 * 1000).toISOString(); return r; } });
    await unlock(s); await withResume(s); await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); await s.page.waitForSelector('#edit-polish .wiz-ok');
    await s.page.waitForFunction(() => /You have four days to finish editing and download your resume/.test(document.getElementById('access-notice').innerText));
    assert.doesNotMatch(await s.page.innerText('#access-notice'), /included AI Polish is still available/); await s.close();
  });

  await t.test('A STALE PAGE: when the included Polish is gone the customer is told, nothing is charged, and the card switches to the paid wording', async () => {
    const a = newAcct({ left: 4, credit: 1 }); const s = await open(a, { 'polish-resume': () => { a.credit = 0; return { status: 409, json: { error: 'Your included AI Polish is no longer available (it may have been used in another window). Nothing was used. Please check your counter, then choose Polish again to continue.', code: 'included_unavailable', newRequest: true, usesRemaining: 4, maxUses: 5 } }; } });
    await unlock(s); await withResume(s); await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm');
    await s.page.waitForFunction(() => /no longer available/.test(document.getElementById('edit-polish').innerText));
    await s.page.waitForFunction(() => !/\(included\)/.test(document.getElementById('edit-polish').innerText));
    const c = await card(s); assert.match(c, /Nothing was used/); assert.match(c, /Uses 1 of your 4 generations/); assert.match(await s.page.innerText('#license-badge'), /4 of 5/); await s.close();
  });

  await t.test('THE FINISHING PERIOD HAS ENDED: sign-in is refused with a clear message; a download that is refused mid-session returns to the sign-in screen and keeps the resume on screen', async () => {
    const gone = newAcct({ valid: false }); const s = await open(gone); await unlock(s);
    const g = await s.page.innerText('#gate-error'); assert.match(g, /four-day finishing period for this code has ended/); assert.match(g, /Etsy shop/); assert.equal(await s.page.isVisible('#license-gate'), true); await s.close();
    setAccessStates({ [GOOD]: 'ended' }); const live = newAcct({ left: 0, credit: 0, state: 'completion', until: new Date(Date.now() + 3600e3).toISOString() });
    const s2 = await open(live); await unlock(s2); await withResume(s2);
    await s2.page.click('#btn-pdf'); await s2.page.waitForSelector('#license-gate', { state: 'visible' });
    assert.match(await s2.page.innerText('#gate-error'), /four-day finishing period for this code has ended/); assert.equal(await s2.page.evaluate(() => state.data.name), 'Maria Delgado', 'the customer\'s resume is still on screen');
    setAccessStates({}); await s2.close();
  });

  await t.test('SAVE REMINDERS: the download reminder sits with the download buttons once; the autosave line appears only after a successful save and never when storage is blocked', async () => {
    const a = newAcct(); const s = await open(a); await unlock(s); await withResume(s);
    assert.equal(await s.page.locator('#export-reminder').count(), 1);
    assert.equal((await s.page.innerText('#export-reminder')).trim(), 'Your resume is not permanently stored online. Drafts saved in this browser may not be available if you change computers or clear browser data. Download your Word and PDF files to keep them.');
    assert.equal(await s.page.evaluate(() => document.getElementById('export-reminder').closest('#export-bar') !== null), true);
    await s.page.waitForTimeout(800); assert.match(await s.page.innerText('#save-status'), /^Progress saved on this device\./);
    await s.close();
    const ctx = await browser.newContext(); await ctx.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }); });
    const s2 = await open(newAcct(), {}, { ctx }); await unlock(s2); await withResume(s2); await s2.page.waitForTimeout(800);
    const txt = await s2.page.innerText('#save-status'); assert.doesNotMatch(txt, /Progress saved on this device/); assert.match(txt, /Saved in this tab only|Couldn’t save on this device/); await s2.close();
  });

  await t.test('AFTER ANALYZE: the notice explains free editing and the included Polish, and the page asks the server for the real count', async () => {
    const a = newAcct({ left: 5, credit: 0 });
    const s = await open(a, { 'parse-resume': () => { a.left = 4; a.credit = 1; return { status: 200, json: { result: JSON.stringify(ORIGINAL), usesRemaining: 4, maxUses: 5, tailorToken: 'tok-a', unverified: [] } }; } });
    await unlock(s); await s.page.fill('#resume-input', 'Maria Delgado, warehouse'); await s.page.click('#parse-btn'); await s.page.waitForSelector('#analyze-next');
    const n = await s.page.innerText('#analyze-next'); assert.match(n, /kept your spelling and wording exactly as you wrote it/); assert.match(n, /editing is always free/); assert.match(n, /Your first AI Polish is included with this analysis, so it uses no generation/);
    await s.page.waitForFunction(() => /\(included\)/.test(document.getElementById('edit-polish').innerText)); assert.match(await s.page.innerText('#license-badge'), /4 of 5/); await s.close();
  });

  t.after(async () => { await browser.close(); server.close(); });
});
