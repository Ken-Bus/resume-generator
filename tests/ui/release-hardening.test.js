// Release hardening, real Chromium, endpoints mocked, fictional people only.
// Every test here runs with the PRODUCTION security headers (netlify.toml, including the Content-Security-Policy) enforced, and fails on any
// page error or policy violation, so every flow doubles as a "the headers do not break the page" check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { exportApi } = require('./export-api');
const { pdfText } = require('../functions/files');

const ROOT = path.join(__dirname, '..', '..');
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const GOOD = 'FG-TEST-AAAA';

// The headers exactly as netlify.toml declares them.
const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
const HEADERS = Object.fromEntries([...toml.slice(toml.indexOf('[[headers]]')).matchAll(/^\s*([A-Za-z-]+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1], m[2]]));
const serve = () => new Promise((r) => {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory() || !TYPES[path.extname(f)]) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)], ...HEADERS }); res.end(fs.readFileSync(f));
  });
  server.listen(0, '127.0.0.1', () => r(server));
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const TAYLOR = { name: 'Taylor Rivera', contact: { phone: '', email: 'taylor.rivera@example.com', location: 'Dayton, OH', linkedin: '', website: '' },
  summary: { tagline: 'Seeking a customer service position', bullets: [], skills: ['Teamwork'] }, experience: [],
  education: [{ degree: 'High School Diploma', school: 'Oakwood High School', location: '', date: '2026', honors: '' }], certifications: [],
  projects: [{ name: 'School Food Drive', description: '', bullets: ['Asked classmates to donate canned food', 'Helped organize food for pickup'] }],
  volunteer: [{ title: 'Volunteer', organization: 'Community Food Pantry', location: '', start: '2025', end: 'Present', bullets: ['Packed grocery boxes on Saturdays', 'Greeted families as they arrived'] }], awards: [] };
const TWO = { ...TAYLOR, projects: [{ name: 'First project', description: '', bullets: ['first bullet'] }, { name: 'Second project', description: '', bullets: ['second bullet'] }] };
const IMPROVED_TWO = { ...TWO, projects: [{ name: 'First project', description: '', bullets: ['First bullet improved'] }, { name: 'Second project', description: '', bullets: ['Second bullet improved'] }] };
const PARSED = { ...TAYLOR, name: 'Parsed Person', projects: [{ name: 'Parsed project', description: '', bullets: ['parsed bullet'] }] };

const polishOk = (result, extra = {}) => () => ({ status: 200, json: { result: JSON.stringify(result), unverified: [], withheld: [], changes: { reworded: 2, cosmetic: 0, unchanged: 5, dropped: 0 }, charged: true, usesRemaining: 4, maxUses: 5, tailorToken: 'tok-p', ...extra } });
const tailorOk = (resume, extra = {}) => () => ({ status: 200, json: { result: JSON.stringify({ resume, matchSummary: { matchedKeywords: ['service'], missingKeywords: [], notes: 'ok' } }), unverified: [], withheld: [], tailorRunsRemaining: 4, ...extra } });

test('release hardening (Chromium, production security headers, mocked endpoints)', async (t) => {
  if (!fs.existsSync(PW) || !fs.existsSync(CHROME)) { t.skip('Playwright/Chromium not available'); return; }
  const { chromium } = require(PW);
  const server = await serve(); const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME });
  const verifyOk = (b) => (b && b.code === GOOD ? { status: 200, json: { valid: true, usesRemaining: 5, maxUses: 5 } } : { status: 200, json: { valid: false, error: 'We couldn’t find that code.' } });

  async function open(api0 = {}, opts = {}) {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: opts.viewport || { width: 1280, height: 900 }, hasTouch: !!opts.touch, isMobile: !!opts.touch });
    const page = await ctx.newPage(); const calls = []; const errors = []; const violations = []; const dialogs = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
    await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
    page.on('dialog', (d) => { dialogs.push(d.message()); (opts.dismiss ? d.dismiss() : d.accept()); });
    const api = { 'verify-license': verifyOk, 'export-resume': exportApi([GOOD]), ...api0 };
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.includes('/.netlify/functions/')) {
        const name = url.split('/.netlify/functions/')[1];
        let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (e) {}
        calls.push({ name, body });
        const r = await (api[name] || (() => ({ status: 500, json: { error: 'unmocked' } })))(body, calls.filter((c) => c.name === name).length);
        if (r.delay) await new Promise((x) => setTimeout(x, r.delay));
        if (r.raw) return route.fulfill({ status: r.status, headers: r.headers, body: Buffer.from(r.body || '', r.isBase64Encoded ? 'base64' : 'utf8') });
        return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.json) });
      }
      return url.startsWith(base) ? route.continue() : route.abort();
    });
    await page.goto(base + '/index.html');
    return { page, ctx, calls, errors, dialogs,
      close: async () => { const csp = await page.evaluate(() => window.__csp).catch(() => []); await ctx.close();
        assert.deepEqual(errors, [], 'no page errors'); assert.deepEqual(violations.concat(csp), [], 'no Content-Security-Policy violations'); } };
  }
  const unlock = async (s) => { await s.page.fill('#gate-code-input', GOOD); await s.page.click('#gate-unlock-btn'); await s.page.waitForTimeout(200); };
  const load = (s, d, panel = 'edit') => s.page.evaluate(([x, p]) => { state.data = JSON.parse(JSON.stringify(x)); state.sampleJson = null; renderEditFields(); renderPreview(); syncChrome(); switchPanel(p); }, [d, panel]);
  const count = (s, name) => s.calls.filter((c) => c.name === name).length;
  const polishNow = async (s) => { await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); };
  const settled = (s) => s.page.waitForFunction(() => !state.aiBusy);

  // ═════════════ one AI step at a time ═════════════
  await t.test('RACE: while Analyze runs, Polish and Tailor cannot start; the fields are frozen; one request per step; nothing is overwritten or lost', async () => {
    const s = await open({ 'parse-resume': () => ({ status: 200, delay: 900, json: { result: JSON.stringify(PARSED), usesRemaining: 4, maxUses: 5, tailorToken: 'tok-a' } }),
      'polish-resume': polishOk(TAYLOR), 'tailor-resume': tailorOk(TAYLOR) });
    await unlock(s); await load(s, TAYLOR, 'paste'); await s.page.fill('#resume-input', 'Parsed Person, a pasted resume');
    await s.page.click('#parse-btn'); await s.page.waitForFunction(() => state.aiBusy === 'analyze');
    assert.equal(await s.page.evaluate(() => document.getElementById('parse-btn').disabled), true);
    assert.equal(await s.page.evaluate(() => document.getElementById('tailor-btn').disabled), true);
    for (const id of ['edit-fields', 'resume-input', 'job-desc-input', 'panel-guide']) assert.equal(await s.page.evaluate((i) => document.getElementById(i).hasAttribute('inert'), id), true, `${id} frozen`);
    await s.page.evaluate(() => switchPanel('edit'));
    assert.equal(await s.page.locator('#edit-polish-btn').count(), 0);                                                    // no Polish button to press
    assert.match(await s.page.innerText('#edit-polish'), /Another AI step is running/);
    await s.page.evaluate(() => { Wiz.askPolish(); Wiz.doPolish(); tailorToJob(); });                                      // even called directly, nothing starts
    await settled(s);
    assert.equal(count(s, 'polish-resume'), 0); assert.equal(count(s, 'tailor-resume'), 0); assert.equal(count(s, 'parse-resume'), 1);
    assert.equal(await s.page.evaluate(() => state.data.name), 'Parsed Person'); assert.equal(await s.page.evaluate(() => state.tailorToken), 'tok-a');
    assert.match(await s.page.innerText('#license-badge'), /4 of 5/);
    assert.equal(await s.page.evaluate(() => document.getElementById('edit-fields').hasAttribute('inert')), false);          // released afterwards
    await s.close();
  });

  await t.test('RACE: while Polish runs, Analyze and Tailor are disabled and typing is frozen; the polished result lands intact and the counter is the server’s', async () => {
    const s = await open({ 'polish-resume': async () => ({ ...polishOk(IMPROVED_TWO)(), delay: 800 }), 'parse-resume': () => ({ status: 200, json: { result: JSON.stringify(PARSED), usesRemaining: 3, maxUses: 5, tailorToken: 'x' } }), 'tailor-resume': tailorOk(TWO) });
    await unlock(s); await load(s, TWO);
    await polishNow(s); await s.page.waitForFunction(() => state.aiBusy === 'polish');
    assert.equal(await s.page.evaluate(() => document.getElementById('parse-btn').disabled), true);
    assert.equal(await s.page.evaluate(() => document.getElementById('tailor-btn').disabled), true);
    assert.equal(await s.page.evaluate(() => document.getElementById('edit-fields').hasAttribute('inert')), true);
    await s.page.evaluate(() => { document.getElementById('resume-input').value = 'x'; parseResume(); tailorToJob(); });
    await settled(s);
    assert.equal(count(s, 'parse-resume'), 0); assert.equal(count(s, 'tailor-resume'), 0); assert.equal(count(s, 'polish-resume'), 1);
    assert.deepEqual(await s.page.evaluate(() => state.data.projects.map((p) => p.bullets[0])), ['First bullet improved', 'Second bullet improved']);
    assert.match(await s.page.innerText('#license-badge'), /4 of 5/); assert.equal(await s.page.evaluate(() => state.tailorToken), 'tok-p');
    await s.close();
  });

  await t.test('RACE: while Tailor runs, Polish and Analyze cannot start; the tailored resume is not overwritten', async () => {
    const tailored = { ...TWO, projects: [{ name: 'First project', description: '', bullets: ['TAILORED first'] }, { name: 'Second project', description: '', bullets: ['second bullet'] }] };
    const s = await open({ 'tailor-resume': async () => ({ ...tailorOk(tailored)(), delay: 800 }), 'polish-resume': polishOk(IMPROVED_TWO), 'parse-resume': () => ({ status: 200, json: { result: JSON.stringify(PARSED), usesRemaining: 3, maxUses: 5 } }) });
    await unlock(s); await load(s, TWO); await s.page.evaluate(() => { state.tailorToken = 'tok0'; });
    await s.page.fill('#job-desc-input', 'Cashier'); await s.page.click('#tailor-btn'); await s.page.waitForFunction(() => state.aiBusy === 'tailor');
    assert.equal(await s.page.locator('#edit-polish-btn').count(), 0); assert.match(await s.page.innerText('#edit-polish'), /Another AI step is running/);
    await s.page.evaluate(() => { Wiz.doPolish(); document.getElementById('resume-input').value = 'x'; parseResume(); });
    await settled(s);
    assert.equal(count(s, 'polish-resume'), 0); assert.equal(count(s, 'parse-resume'), 0);
    assert.equal(await s.page.evaluate(() => state.data.projects[0].bullets[0]), 'TAILORED first');
    await s.close();
  });

  await t.test('after a step finishes everything is usable again: typing works, the next AI step can run', async () => {
    const s = await open({ 'polish-resume': polishOk(IMPROVED_TWO) });
    await unlock(s); await load(s, TWO); await polishNow(s); await settled(s); await s.page.waitForSelector('#edit-polish .wiz-ok');
    await s.page.fill('#edit-fields input.field-input', 'Typed After'); assert.equal(await s.page.evaluate(() => state.data.name), 'Typed After');
    assert.equal(await s.page.evaluate(() => document.getElementById('tailor-btn').disabled), false);
    assert.equal(await s.page.locator('#edit-polish-btn').count(), 1);
    await s.close();
  });

  await t.test('A STALLED request cannot freeze the editor: after the client timeout the lock is released, the customer is told to check the counter, and a retry reuses the same request id (no double charge)', async () => {
    let n = 0;
    const s = await open({ 'polish-resume': () => { n++; return n === 1 ? { status: 200, delay: 2500, json: {} } : polishOk(IMPROVED_TWO)(); } });
    await unlock(s); await load(s, TWO); await s.page.evaluate(() => { AI_CLIENT_TIMEOUT_MS = 400; });
    await polishNow(s); await s.page.waitForFunction(() => state.aiBusy === 'polish');
    assert.equal(await s.page.evaluate(() => document.getElementById('edit-fields').hasAttribute('inert')), true);
    await s.page.waitForFunction(() => !state.aiBusy, null, { timeout: 5000 });                                               // released by the timeout, not by the server
    assert.equal(await s.page.evaluate(() => document.getElementById('edit-fields').hasAttribute('inert')), false);
    assert.match(await s.page.innerText('#edit-polish .wiz-err'), /couldn’t confirm whether that finished[\s\S]*counter/);
    await s.page.fill('#edit-fields input.field-input', 'Typed After Timeout'); assert.equal(await s.page.evaluate(() => state.data.name), 'Typed After Timeout');
    const polishCalls = () => s.calls.filter((c) => c.name === 'polish-resume'); const id1 = polishCalls()[0].body.requestId;
    await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); await s.page.waitForSelector('#edit-polish .wiz-ok');
    assert.equal(polishCalls().length, 2); assert.equal(polishCalls()[1].body.requestId, id1);                                                            // same id: the server will not charge twice for the same attempt
    await s.close();
  });

  // ═════════════ Restore My Wording ═════════════
  await t.test('RESTORE: after the customer deletes an entry, Restore puts wording back into the RIGHT entry only (never another entry)', async () => {
    const s = await open({ 'polish-resume': polishOk(IMPROVED_TWO) });
    await unlock(s); await load(s, TWO); await polishNow(s); await s.page.waitForSelector('#edit-polish .wiz-ok');
    await s.page.evaluate(() => { state.data.projects.splice(0, 1); renderEditFields(); renderPreview(); Wiz.refreshPolish(); });
    const rows = await s.page.locator('#edit-polish .wiz-review-row').allInnerTexts();
    assert.equal(rows.length, 1); assert.match(rows[0], /Project: Second project/); assert.doesNotMatch(rows[0], /First project/);
    await s.page.click('#edit-polish .wiz-review-row button');
    assert.deepEqual(await s.page.evaluate(() => state.data.projects.map((p) => [p.name, p.bullets])), [['Second project', ['second bullet']]]);
    await s.close();
  });

  await t.test('RESTORE: a renamed or re-ordered entry is matched by name; an entry that cannot be matched is left alone, never guessed', async () => {
    const s = await open({ 'polish-resume': polishOk(IMPROVED_TWO) });
    await unlock(s); await load(s, TWO); await polishNow(s); await s.page.waitForSelector('#edit-polish .wiz-ok');
    await s.page.evaluate(() => { state.data.projects.reverse(); renderEditFields(); Wiz.refreshPolish(); });                  // re-ordered
    await s.page.locator('#edit-polish .wiz-review-row', { hasText: 'First project' }).locator('button').click();
    assert.deepEqual(await s.page.evaluate(() => state.data.projects.map((p) => [p.name, p.bullets[0]])), [['Second project', 'Second bullet improved'], ['First project', 'first bullet']]);
    await s.page.evaluate(() => { state.data.projects[0].name = 'Renamed by me'; renderEditFields(); Wiz.refreshPolish(); });  // renamed: no longer the same entry
    assert.equal(await s.page.locator('#edit-polish .wiz-review-row', { hasText: 'Renamed' }).count(), 0);
    assert.equal(await s.page.evaluate(() => state.data.projects[0].bullets[0]), 'Second bullet improved');
    await s.close();
  });

  await t.test('RESTORE ALL: asks before throwing away edits made after the polish (and does nothing if you say no); no question if nothing changed', async () => {
    const s = await open({ 'polish-resume': polishOk(IMPROVED_TWO) }, { dismiss: true });
    await unlock(s); await load(s, TWO); await polishNow(s); await s.page.waitForSelector('#edit-polish .wiz-ok');
    await s.page.evaluate(() => { state.data.projects[0].bullets.push('MY NEW BULLET'); state.data.name = 'Taylor R. Rivera'; });
    await s.page.click('#edit-polish button:has-text("Restore all")');
    assert.equal(s.dialogs.length, 1); assert.match(s.dialogs[0], /changed your resume since the polish/);
    assert.equal(await s.page.evaluate(() => state.data.projects[0].bullets.includes('MY NEW BULLET')), true);                  // declined: nothing was lost
    assert.equal(await s.page.evaluate(() => state.polishOriginal !== null), true);
    await s.close();
    const s2 = await open({ 'polish-resume': polishOk(IMPROVED_TWO) });                                                        // accepting restores everything
    await unlock(s2); await load(s2, TWO); await polishNow(s2); await s2.page.waitForSelector('#edit-polish .wiz-ok');
    await s2.page.evaluate(() => { state.data.projects[0].bullets.push('MY NEW BULLET'); });
    await s2.page.click('#edit-polish button:has-text("Restore all")');
    assert.equal(s2.dialogs.length, 1); assert.deepEqual(await s2.page.evaluate(() => state.data.projects.map((p) => p.bullets)), [['first bullet'], ['second bullet']]);
    await s2.close();
    const s3 = await open({ 'polish-resume': polishOk(IMPROVED_TWO) });                                                        // untouched: no question
    await unlock(s3); await load(s3, TWO); await polishNow(s3); await s3.page.waitForSelector('#edit-polish .wiz-ok');
    await s3.page.click('#edit-polish button:has-text("Restore all")'); assert.equal(s3.dialogs.length, 0);
    await s3.close();
  });

  await t.test('RESTORE after tailoring: the old Undo-tailoring button and notes are cleared (they cannot bring back polished text)', async () => {
    const tailored = { ...IMPROVED_TWO, projects: [{ name: 'First project', description: '', bullets: ['TAILORED'] }, IMPROVED_TWO.projects[1]] };
    const s = await open({ 'polish-resume': polishOk(IMPROVED_TWO), 'tailor-resume': tailorOk(tailored) });
    await unlock(s); await load(s, TWO); await polishNow(s); await s.page.waitForSelector('#edit-polish .wiz-ok');
    await s.page.fill('#job-desc-input', 'Cashier'); await s.page.click('#tailor-btn'); await s.page.waitForSelector('#match-summary-box button');
    await s.page.click('#edit-polish button:has-text("Restore all")');
    assert.match(s.dialogs[0], /tailoring it/);
    assert.equal(await s.page.evaluate(() => state.preTailor), null); assert.equal(await s.page.locator('#match-summary-box button').count(), 0);
    assert.deepEqual(await s.page.evaluate(() => state.data.projects.map((p) => p.bullets)), [['first bullet'], ['second bullet']]);
    await s.close();
  });

  // ═════════════ Analyze ═════════════
  await t.test('ANALYZE asks before replacing the customer’s own work, and not before replacing the untouched sample', async () => {
    const parse = () => ({ status: 200, json: { result: JSON.stringify(PARSED), unverified: [], usesRemaining: 4, maxUses: 5, tailorToken: 'tt' } });
    const s = await open({ 'parse-resume': parse }, { dismiss: true });
    await unlock(s); await load(s, TAYLOR, 'paste'); await s.page.fill('#resume-input', 'Parsed Person text'); await s.page.click('#parse-btn'); await s.page.waitForTimeout(300);
    assert.equal(s.dialogs.length, 1); assert.match(s.dialogs[0], /replace the resume currently in the editor/); assert.equal(count(s, 'parse-resume'), 0);   // declined: no request, no charge
    assert.equal(await s.page.evaluate(() => state.data.name), 'Taylor Rivera'); assert.equal(await s.page.evaluate(() => state.aiBusy), null);
    await s.close();
    const s2 = await open({ 'parse-resume': parse });                                                                          // accepted
    await unlock(s2); await load(s2, TAYLOR, 'paste'); await s2.page.fill('#resume-input', 'Parsed Person text'); await s2.page.click('#parse-btn'); await settled(s2);
    assert.equal(s2.dialogs.length, 1); assert.equal(await s2.page.evaluate(() => state.data.name), 'Parsed Person'); await s2.close();
    const s3 = await open({ 'parse-resume': parse });                                                                          // sample: no question
    await unlock(s3); await s3.page.evaluate(() => loadSample()); await s3.page.evaluate(() => switchPanel('paste'));
    await s3.page.fill('#resume-input', 'Parsed Person text'); await s3.page.click('#parse-btn'); await settled(s3);
    assert.equal(s3.dialogs.length, 0); assert.equal(await s3.page.evaluate(() => state.data.name), 'Parsed Person'); await s3.close();
  });

  await t.test('ANALYZE: details that are not in the pasted text are shown in yellow with the reason, and the long-resume limit is 20,000 characters', async () => {
    const withNumber = { ...PARSED, experience: [{ title: 'Associate', company: 'Fictional Co', location: '', start: '2020', end: '2024', summary: '', bullets: ['Increased sales by 40%'] }] };
    const s = await open({ 'parse-resume': () => ({ status: 200, json: { result: JSON.stringify(withNumber), unverified: [{ where: 'experience.0.bullets.0', text: 'Increased sales by 40%', kind: 'claim', reasons: ['number not in the text you pasted: 40'] }], usesRemaining: 4, maxUses: 5, tailorToken: 'tt' } }) });
    await unlock(s); await s.page.evaluate(() => switchPanel('paste')); await s.page.fill('#resume-input', 'Parsed Person'); await s.page.click('#parse-btn'); await settled(s);
    assert.match(await s.page.innerText('#analyze-notice'), /Please check 1 line[\s\S]*Increased sales by 40%[\s\S]*number not in the text you pasted/);
    assert.equal(await s.page.locator('textarea.flag-warn').count(), 1);
    await s.page.evaluate(() => { switchPanel('paste'); document.getElementById('resume-input').value = 'x'.repeat(20001); }); await s.page.click('#parse-btn');
    assert.match(await s.page.innerText('#error-box'), /limit 20,000 characters/); assert.equal(count(s, 'parse-resume'), 1);       // refused in the browser: no second request
    await s.close();
  });

  // ═════════════ what the customer is told about withheld suggestions ═════════════
  await t.test('POLISH where every suggestion is withheld: one yellow explanation with where and why, no AI text, nothing changed, nothing charged, no error', async () => {
    const withheld = [{ where: 'projects.0.bullets.0', label: 'Project: School Food Drive, bullet 1', kind: 'claim', reasons: ['details from a different part of your resume: “families”'] },
      { where: 'projects.0.bullets.1', label: 'Project: School Food Drive, bullet 2', kind: 'claim', reasons: ['your role changed: you wrote that you helped with this, but it now says “organized”'] }];
    const s = await open({ 'polish-resume': () => ({ status: 200, json: { noChange: true, charged: false, reason: 'flagged', withheld, changes: { reworded: 0, cosmetic: 0, unchanged: 8, dropped: 0 }, usesRemaining: 5, maxUses: 5 } }) });
    await unlock(s); await load(s, TAYLOR); const before = await s.page.evaluate(() => JSON.stringify(state.data));
    await polishNow(s); await settled(s); await s.page.waitForSelector('#edit-polish-nochange');
    const box = await s.page.innerText('#edit-polish-nochange');
    assert.match(box, /The AI’s suggestions were not used/); assert.match(box, /No generation was used \(5 of 5 left\)/);
    assert.match(box, /Project: School Food Drive, bullet 1[\s\S]*families/); assert.match(box, /bullet 2[\s\S]*your role changed/);
    assert.equal(await s.page.locator('#edit-polish .wiz-err, #edit-polish .wiz-ok').count(), 0);                                  // exactly one outcome
    assert.equal(await s.page.evaluate(() => JSON.stringify(state.data)), before); assert.match(await s.page.innerText('#license-badge'), /5 of 5/);
    await s.close();
  });

  await t.test('POLISH with some accepted and some withheld: green result plus a "left out" list; counter drops by one; Tailor token issued', async () => {
    const withheld = [{ where: 'projects.0.bullets.1', label: 'Project: School Food Drive, bullet 2', kind: 'claim', reasons: ['your role changed: you wrote that you helped with this, but it now says “organized”'] }];
    const accepted = clone(TAYLOR); accepted.volunteer[0].bullets[1] = 'Greeted arriving families';
    const s = await open({ 'polish-resume': polishOk(accepted, { withheld, changes: { reworded: 1, cosmetic: 0, unchanged: 8, dropped: 0 } }) });
    await unlock(s); await load(s, TAYLOR); await polishNow(s); await settled(s); await s.page.waitForSelector('#edit-polish .wiz-ok');
    assert.match(await s.page.innerText('#edit-polish .wiz-ok'), /Polished[\s\S]*Activity: Volunteer/);
    assert.match(await s.page.innerText('#edit-polish-withheld'), /1 suggested change was left out[\s\S]*bullet 2[\s\S]*your role changed/);
    assert.equal(await s.page.locator('#edit-polish-nochange').count(), 0);
    assert.match(await s.page.innerText('#license-badge'), /4 of 5/); assert.equal(await s.page.evaluate(() => state.tailorToken), 'tok-p');
    await s.close();
  });

  await t.test('TAILOR reports what it left out, and never lists a keyword as matched that the server moved to "not covered"', async () => {
    const withheld = [{ where: 'volunteer.0.bullets.1', label: 'Activity: Volunteer, bullet 2', kind: 'claim', reasons: ['details from a different part of your resume: “pickup”'] }];
    const s = await open({ 'tailor-resume': () => ({ status: 200, json: { result: JSON.stringify({ resume: TAYLOR, matchSummary: { matchedKeywords: ['teamwork'], missingKeywords: ['forklift'], notes: 'ok' } }), unverified: [], withheld, tailorRunsRemaining: 4 } }) });
    await unlock(s); await load(s, TAYLOR); await s.page.evaluate(() => { state.tailorToken = 'tok0'; });
    await s.page.fill('#job-desc-input', 'Cashier'); await s.page.click('#tailor-btn'); await s.page.waitForSelector('#match-summary-box .notice-box');
    const box = await s.page.innerText('#match-summary-box');
    assert.match(box, /1 suggested change was left out[\s\S]*Activity: Volunteer, bullet 2/); assert.match(box, /Matched:\s*teamwork/); assert.match(box, /Not covered:\s*forklift/);
    assert.match(await s.page.innerText('#license-badge'), /5 of 5/);                                                              // Tailor never touches the balance
    await s.close();
  });

  await t.test('too-long resumes: the friendly server message is shown for Polish and Tailor, nothing is charged, nothing changes, the buttons recover', async () => {
    const s = await open({ 'polish-resume': () => ({ status: 413, json: { error: 'This resume is too long to polish in one go. You haven’t been charged. Shorten it a little (fewer or shorter entries) and try again.' } }),
      'tailor-resume': () => ({ status: 413, json: { error: 'This resume (with that job description) is too long to tailor in one go. Please shorten it a little, or paste only the key sections of the job description, and try again.' } }) });
    await unlock(s); await load(s, TAYLOR); await s.page.evaluate(() => { state.tailorToken = 'tok0'; }); const before = await s.page.evaluate(() => JSON.stringify(state.data));
    await polishNow(s); await settled(s); assert.match(await s.page.innerText('#edit-polish .wiz-err'), /too long to polish in one go[\s\S]*haven’t been charged/);
    assert.equal(await s.page.locator('#edit-polish-btn').count(), 1);
    await s.page.fill('#job-desc-input', 'Cashier'); await s.page.click('#tailor-btn'); await s.page.waitForSelector('#match-summary-box');
    assert.match(await s.page.innerText('#match-summary-box'), /too long to tailor in one go/); assert.equal(await s.page.evaluate(() => document.getElementById('tailor-btn').disabled), false);
    assert.equal(await s.page.evaluate(() => JSON.stringify(state.data)), before); assert.match(await s.page.innerText('#license-badge'), /5 of 5/);
    await s.close();
  });

  // ═════════════ hostile and sparse content ═════════════
  await t.test('HOSTILE TEXT everywhere is shown literally: editor, preview and the polish card; nothing runs; no policy violation', async () => {
    const evil = clone(TAYLOR); evil.projects[0].bullets = ['</textarea><img src=x onerror="window.__x1=1">', '"><script>window.__x2=1</script>'];
    evil.projects[0].description = '<svg onload="window.__x3=1">'; evil.name = '<b onmouseover="window.__x4=1">Taylor</b>';
    const polished = clone(evil); polished.projects[0].bullets[1] = '"><script>window.__x2=1</script> improved';
    const s = await open({ 'polish-resume': polishOk(polished, { withheld: [{ where: 'x', label: '<img src=x onerror="window.__x5=1">', kind: 'claim', reasons: ['<script>window.__x6=1</script>'] }] }) });
    await unlock(s); await load(s, evil); await polishNow(s); await settled(s); await s.page.waitForSelector('#edit-polish .wiz-ok'); await s.page.waitForTimeout(200);
    assert.deepEqual(await s.page.evaluate(() => Object.keys(window).filter((k) => /^__x\d$/.test(k))), []);
    assert.deepEqual(await s.page.evaluate(() => [...document.querySelectorAll('#edit-polish *, #edit-fields *, #resume-preview *')].filter((e) => ['IMG', 'SCRIPT', 'IFRAME', 'OBJECT'].includes(e.tagName) || [...e.attributes].some((a) => /^on(error|load|mouseover)$/i.test(a.name))).map((e) => `${e.tagName} inside ${e.parentElement.tagName}#${e.parentElement.id || e.parentElement.className}: ${e.outerHTML.slice(0, 80)}`)), []);
    const boxes = await s.page.locator('#edit-fields textarea').evaluateAll((els) => els.map((e) => e.value));
    assert.ok(boxes.some((v) => /<\/textarea><img src=x/.test(v)) && boxes.some((v) => /^<svg onload=/.test(v)), 'the hostile text is inside the boxes, as plain text');
    await s.close();
  });

  await t.test('SPARSE resumes: name only, skills only, contact only: no empty headings, polish offered only when there is something to polish, exports refused or served politely', async () => {
    const s = await open({ 'polish-resume': polishOk(TAYLOR) });
    await unlock(s);
    await load(s, { name: 'Only A Name' });
    assert.match(await s.page.innerText('#edit-polish'), /Add a few answers first/); assert.equal(await s.page.locator('#edit-polish-btn').count(), 0);
    const preview = await s.page.innerText('#resume-preview'); assert.match(preview, /Only A Name/i); assert.doesNotMatch(preview, /EXPERIENCE|EDUCATION|PROJECTS|SKILLS|undefined|null|\[object/i);
    await load(s, { summary: { skills: ['Teamwork'] } });
    assert.equal(await s.page.locator('#edit-polish-btn').count(), 1);                                                              // skills alone are something to polish
    await s.page.evaluate(() => { state.data = ResumeCore.blank(); renderEditFields(); renderPreview(); syncChrome(); });
    assert.equal(await s.page.isVisible('#export-bar'), false);
    await s.close();
  });

  await t.test('EXPORT after an accepted polish contains exactly the accepted wording (real PDF), and the licensed download never uses a generation', async () => {
    const s = await open({ 'polish-resume': polishOk(IMPROVED_TWO) });
    await unlock(s); await load(s, TWO); await polishNow(s); await s.page.waitForSelector('#edit-polish .wiz-ok');
    const dl = s.page.waitForEvent('download'); await s.page.click('#btn-pdf'); const file = await (await dl).path();
    const text = await pdfText(fs.readFileSync(file));
    assert.match(text, /First bullet improved/); assert.match(text, /Second bullet improved/); assert.doesNotMatch(text, /undefined|\[object Object\]|NaN/);
    assert.match(await s.page.innerText('#license-badge'), /4 of 5/); assert.equal(count(s, 'verify-license') >= 1, true);
    await s.close();
  });

  // ═════════════ phones ═════════════
  for (const vp of [{ width: 375, height: 667 }, { width: 320, height: 568 }]) {
    await t.test(`PHONE ${vp.width}x${vp.height}: no sideways scrolling, 16px inputs (no iOS zoom), tap targets of at least 40px, and the export bar never hides the last field`, async () => {
      const s = await open({ 'polish-resume': polishOk(IMPROVED_TWO) }, { viewport: vp, touch: true });
      const audit = () => s.page.evaluate(() => {
        const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('[inert]') === true || (r.width > 0 && r.height > 0 && cs.display !== 'none'); };
        const bad = { overflowX: document.documentElement.scrollWidth > innerWidth + 1, small: [], tiny: [] };
        document.querySelectorAll('button, a[href], [onclick], select, input[type=checkbox], input[type=radio]').forEach((e) => {
          if (!vis(e) || e.closest('#resume-preview') || e.closest('.category-tabs')) return;
          const r = (e.matches('input') && e.closest('label') ? e.closest('label') : e).getBoundingClientRect();     // a checkbox is tapped through its label
          if (r.height < 39 || r.width < 39) bad.small.push(`${(e.innerText || e.id || e.className || e.tagName).toString().trim().slice(0, 28)} ${Math.round(r.width)}x${Math.round(r.height)}`); });
        document.querySelectorAll('input[type=text], input:not([type]), textarea, select').forEach((e) => { if (vis(e) && !e.closest('#resume-preview') && parseFloat(getComputedStyle(e).fontSize) < 16) bad.tiny.push(e.id || e.className); });
        return bad;
      });
      const issues = [];                                                                       // collected across every screen, reported together
      const expectClean = async (label) => { const a = await audit(); if (a.overflowX) issues.push(`${label}: sideways scroll`); if (a.tiny.length) issues.push(`${label}: inputs under 16px: ${[...new Set(a.tiny)].join(',')}`); if (a.small.length) issues.push(`${label}: tap targets under 40px: ${[...new Set(a.small)].join('; ')}`); };
      await expectClean('gate');
      await unlock(s); await expectClean('start screen');
      await s.page.click('#start-first'); await s.page.waitForSelector('#panel-guide .wiz-title');
      for (let i = 0; i < 7; i++) { await s.page.evaluate((n) => Wiz.go(n), i); await s.page.waitForTimeout(40); await expectClean(`builder step ${i + 1}`); }
      await load(s, { ...TWO, experience: [{ title: 'Warehouse Associate and Shift Lead', company: 'Fictional Freight Company International', location: 'Dayton, OH', start: 'January 2015', end: 'Present', summary: '', bullets: ['Showed new coworkers how to use the pallet jack and kept the dock clean and safe for everyone'] }] });
      await expectClean('editor');
      await polishNow(s); await settled(s); await s.page.waitForSelector('#edit-polish .wiz-ok'); await expectClean('editor after a polish');
      // scroll to the very bottom: the last editable field must end above the floating export buttons
      const cover = await s.page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); const bar = document.getElementById('export-bar').getBoundingClientRect(); const fields = [...document.querySelectorAll('#panel-edit textarea, #panel-edit input, #panel-edit button')].filter((e) => e.offsetParent); const last = fields.pop().getBoundingClientRect(); return { barTop: bar.top, lastBottom: last.bottom, overlaps: last.bottom > bar.top + 1 && last.top < bar.bottom && last.right > bar.left && last.left < bar.right }; });
      if (cover.overlaps) issues.push(`export bar covers the last field: ${JSON.stringify(cover)}`);
      assert.deepEqual(issues, []);
      await s.close();
    });
  }

  await browser.close(); server.close();
});
