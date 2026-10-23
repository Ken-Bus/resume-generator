// SYSTEM STRESS in real Chromium: Paste -> Analyze -> Polish -> Edit Fields -> Restore -> Tailor -> PDF/Word, plus Guided Builder, on a
// desktop and an Android-sized screen. The "server" behind the page is a simulation built from the REAL integrity guard, the REAL change
// assessment and the real charging rule (a generation is spent only for a rewrite), and the REAL export renderer. Only the AI answer and the
// database are scripted. A final test sabotages the simulated server and shows these assertions fail, so they cannot pass by accident.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const { exportApi } = require('./export-api');
const { pdfText, docxText } = require('../functions/files');
const { realReword } = require('../functions/harness');
const { P, clone } = require('../functions/personas');
const Core = require('../../resume-core.js');
const integrity = require('../../netlify/functions/_lib/integrity');
const GOOD = 'FG-TEST-AAAA';
const POISON = [/families in the community/i, /\b40%/, /Supervised/, /resulting in/i];

function serve() {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// ── the simulated server ────────────────────────────────────────────────────────────────────────────────────────────────
function simServer({ parsed, polish, tailor, guard = integrity.guardResume, assess = integrity.assessChange }) {
  const st = { uses: 5, polishCalls: 0, parseCalls: 0, tailorCalls: 0, tailorRuns: 5 };
  const stamp = { version: Core.GUARD_VERSION, withholds: true };
  const api = {
    'verify-license': (b) => (b && b.code === GOOD ? { status: 200, json: { valid: true, usesRemaining: st.uses, maxUses: 5 } } : { status: 200, json: { valid: false, error: 'We couldn’t find that code.' } }),
    'export-resume': exportApi([GOOD]),
    'parse-resume': (b) => { st.parseCalls++; st.uses--; return { status: 200, json: { result: JSON.stringify(integrity.groundAnalyzed(b.resumeText, parsed(b.resumeText)).resume), unverified: [], usesRemaining: st.uses, maxUses: 5, tailorToken: 'tok-a' } }; },
    'polish-resume': (b) => {
      st.polishCalls++;
      if (b.clientGuard !== Core.GUARD_VERSION) return { status: 409, json: { error: 'This page is out of date.', stale: true } };
      const source = Core.clean(b.resume); const g = guard(source, polish(source, b), { mode: 'polish', vocabulary: b.target }); const changes = assess(source, g.resume);
      if (changes.reworded === 0) return { status: 200, json: { guard: stamp, noChange: true, charged: false, reason: g.withheld.length ? 'flagged' : changes.minor > 0 ? 'minor' : 'unchanged', withheld: g.withheld, changes, usesRemaining: st.uses, maxUses: 5 } };
      st.uses--; return { status: 200, json: { guard: stamp, result: JSON.stringify(g.resume), unverified: [], withheld: g.withheld, changes, charged: true, usesRemaining: st.uses, maxUses: 5, tailorToken: 'tok-p' } };
    },
    'tailor-resume': (b) => {
      st.tailorCalls++; const source = Core.clean(b.resumeData); const t = tailor(source, b.jobDescription); const g = guard(source, t.resume, { mode: 'tailor' });
      return { status: 200, json: { result: JSON.stringify({ resume: g.resume, matchSummary: t.matchSummary || { matchedKeywords: ['service'], missingKeywords: [], notes: 'ok' } }), unverified: [], withheld: g.withheld, tailorRunsRemaining: --st.tailorRuns } };
    }
  };
  return { st, api };
}
const rewriteFirst = (r) => { const o = clone(r); const refs = ['experience', 'volunteer', 'projects'].flatMap((k) => (o[k] || []).flatMap((e) => (e.bullets || []).map((b, j) => ({ e, j, b })))).filter((x) => x.b.trim().split(/\s+/).length >= 3); if (refs[0]) refs[0].e.bullets[refs[0].j] = realReword(refs[0].b); return o; };
const goodPlusBad = (r) => { const o = rewriteFirst(r); const pr = (o.projects || []).find((p) => !String(p.description || '').trim()); if (pr) pr.description = 'Collected donated food for families in the community.';
  const last = o.volunteer && o.volunteer[0] && o.volunteer[0].bullets; if (last) last[last.length - 1] += ' and increased donations by 40%'; return o; };
const echo = (r) => clone(r);
const oneWord = (r) => { const o = clone(r); o.projects[0].bullets[2] = 'Helped organize donated food for pickup'; return o; };
const tailorSwap = (r) => ({ resume: (() => { const o = clone(r); o.summary.tagline = 'Seeking a customer service position'; return o; })() });

test('SYSTEM STRESS (Chromium, simulated server built from the real guard and charging rule)', async (t) => {
  if (!fs.existsSync(PW) || !fs.existsSync(CHROME)) { t.skip('Playwright/Chromium not available'); return; }
  const { chromium } = require(PW);
  const server = await serve(); const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(async () => { await browser.close(); server.close(); });
  const layouts = { desktop: { viewport: { width: 1280, height: 900 } }, android: { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true } };

  async function open(sim, layout = 'desktop') {
    const ctx = await browser.newContext({ acceptDownloads: true, ...layouts[layout] }); const page = await ctx.newPage(); const errors = []; const calls = []; const dialogs = [];
    page.on('pageerror', (e) => errors.push(String(e))); page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.includes('/.netlify/functions/')) {
        const name = url.split('/.netlify/functions/')[1]; let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (e) {}
        calls.push({ name, body }); const r = await (sim.api[name] || (() => ({ status: 500, json: { error: 'unmocked' } })))(body);
        if (r.raw) return route.fulfill({ status: r.status, headers: r.headers, body: Buffer.from(r.body || '', r.isBase64Encoded ? 'base64' : 'utf8') });
        return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.json) });
      }
      return url.startsWith(base) ? route.continue() : route.abort();
    });
    await page.goto(base + '/index.html');
    await page.fill('#gate-code-input', GOOD); await page.click('#gate-unlock-btn'); await page.waitForSelector('#license-gate', { state: 'hidden' });
    return { page, calls, errors, dialogs, close: async () => { await ctx.close(); assert.deepEqual(errors, [], 'no page errors'); } };
  }
  const badge = (s) => s.page.innerText('#license-badge');
  const edit = (s) => s.page.evaluate(() => { switchPanel('edit'); });
  const allFieldText = (s) => s.page.locator('#edit-fields textarea, #edit-fields input').evaluateAll((els) => els.map((e) => e.value).join('\n'));
  const download = async (s, sel) => { const [dl] = await Promise.all([s.page.waitForEvent('download'), s.page.click(sel)]); return fs.readFileSync(await dl.path()); };
  const noPoison = (text, where) => POISON.forEach((re) => assert.doesNotMatch(text, re, `${where} contains unsupported text ${re}`));

  // The whole journey. `sim` is the (possibly sabotaged) server; the assertions are the same either way.
  async function journey(layout, sim) {
        const s = await open(sim, layout);
    // 1. Paste -> Analyze
    await s.page.evaluate(() => switchPanel('paste')); await s.page.fill('#resume-input', 'Taylor Rivera. School Food Drive project. Volunteer at Community Food Pantry. High school diploma 2026.');
    await s.page.click('#parse-btn'); await s.page.waitForFunction(() => state.data && state.data.name === 'Taylor Rivera' && !state.aiBusy);
    assert.match(await badge(s), /4 of 5/); assert.equal(s.calls.find((c) => c.name === 'parse-resume').body.clientGuard, Core.GUARD_VERSION);
    // Analyze never keeps what the pasted text does not contain: the email and the volunteer start year were not pasted, so they are gone.
    const analyzed = await s.page.evaluate(() => JSON.parse(JSON.stringify(ResumeCore.clean(state.data))));
    assert.equal(analyzed.contact.email, ''); assert.equal(analyzed.volunteer[0].start, ''); assert.equal(analyzed.name, 'Taylor Rivera');
    await edit(s);
    // 2. Polish: one real rewrite next to unsupported additions
    await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); await s.page.waitForFunction(() => !state.polish.busy); await s.page.waitForTimeout(150);
    assert.match(await badge(s), /3 of 5/, 'one generation for the one real rewrite'); const preview = await s.page.innerText('#resume-preview');
    noPoison(preview, 'the preview'); noPoison(await allFieldText(s), 'the editor');
    assert.equal(await s.page.locator('#edit-fields textarea.flag-warn').count(), 0, 'nothing is shown as "kept with a warning"');
    assert.match(await s.page.innerText('#edit-polish'), /left out/i);
    // 3. exports show exactly what is on screen
    const pdf = pdfText(await download(s, '#btn-pdf')); const doc = docxText(await download(s, '#btn-word'));
    noPoison(pdf, 'the PDF'); noPoison(doc, 'the Word file'); assert.match(pdf, /taylor rivera/i); assert.match(doc, /taylor rivera/i);
    assert.match(await badge(s), /3 of 5/, 'downloads never spend a generation');
    // 4. customer edits one project then restores just that part
    const state1 = await s.page.evaluate(() => JSON.parse(JSON.stringify(ResumeCore.clean(state.data))));
    await s.page.evaluate(() => { state.data.projects[1].bullets[0] = 'Tested four filter designs at home'; renderEditFields(); renderPreview(); });
    await s.page.evaluate(() => Wiz.restorePart('projects', 1));
    const afterPart = await s.page.evaluate(() => ResumeCore.clean(state.data));
    assert.deepEqual(afterPart.projects[1], analyzed.projects[1], 'restore put back that project\'s own wording'); assert.deepEqual(afterPart.projects[0], state1.projects[0], 'and left the other project alone');
    assert.ok(s.dialogs.some((d) => /changed this part since the polish/i.test(d)), 'it asked before discarding the customer\'s own edit');
    // 5. Restore all
    await s.page.evaluate(() => Wiz.restoreAll());
    assert.deepEqual(await s.page.evaluate(() => ResumeCore.clean(state.data)), analyzed, 'Restore all returns the customer\'s own resume exactly');
    noPoison(await s.page.innerText('#resume-preview'), 'the restored preview');
    await s.close(); return sim.st;
  }
  const parsedTaylor = () => clone(P.firstDetailed);
  for (const layout of Object.keys(layouts)) {
    await t.test(`[${layout}] Paste -> Analyze -> Polish (one rewrite + unsupported additions) -> Edit Fields -> PDF/Word -> Restore part -> Restore all`, async () => {
      const st = await journey(layout, simServer({ parsed: parsedTaylor, polish: goodPlusBad, tailor: tailorSwap }));
      assert.equal(st.polishCalls, 1); assert.equal(st.uses, 3);
    });
  }

  await t.test('META: the same journey FAILS against a sabotaged server (guard off), so the assertions above are able to catch the defect', async () => {
    const sab = simServer({ parsed: parsedTaylor, polish: goodPlusBad, tailor: tailorSwap, guard: (orig, out) => ({ resume: Core.clean(out), withheld: [] }) });
    await assert.rejects(() => journey('desktop', sab), /unsupported text|families in the community|flag/i);
  });
  await t.test('META: and against a server that charges for a one-word touch-up', async () => {
    const sab = simServer({ parsed: parsedTaylor, polish: oneWord, tailor: tailorSwap, assess: (a, b) => { const r = integrity.assessChange(a, b); return { ...r, reworded: r.reworded + r.minor }; } });
    const s = await open(sab); await s.page.evaluate((d) => { state.data = JSON.parse(JSON.stringify(d)); renderEditFields(); renderPreview(); switchPanel('edit'); }, P.firstDetailed);
    await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); await s.page.waitForFunction(() => !state.polish.busy);
    assert.match(await badge(s), /4 of 5/, 'the sabotaged server really charged'); await s.close();
  });

  // ── the owner's complaint, end to end ──
  for (const layout of Object.keys(layouts)) {
    await t.test(`[${layout}] A ONE-WORD TOUCH-UP IS FREE: nothing is charged, nothing is changed, the card says so plainly, no Restore button appears`, async () => {
      const sim = simServer({ parsed: parsedTaylor, polish: oneWord, tailor: tailorSwap }); const s = await open(sim, layout);
      await s.page.evaluate((d) => { state.data = JSON.parse(JSON.stringify(d)); renderEditFields(); renderPreview(); switchPanel('edit'); }, P.firstDetailed);
      const before = await s.page.evaluate(() => JSON.stringify(ResumeCore.clean(state.data)));
      await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); await s.page.waitForFunction(() => !state.polish.busy); await s.page.waitForTimeout(150);
      assert.match(await badge(s), /5 of 5/); assert.equal(sim.st.uses, 5);
      assert.equal(await s.page.evaluate(() => JSON.stringify(ResumeCore.clean(state.data))), before, 'the resume is untouched');
      const card = await s.page.innerText('#edit-polish'); assert.match(card, /Only tiny touch-ups were found/); assert.match(card, /No generation was used/); assert.match(card, /5 of 5 left/);
      assert.equal(await s.page.locator('#edit-polish .wiz-err').count(), 0, 'not an error'); assert.doesNotMatch(card, /Restore all/);
      if (layout === 'android') assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no sideways scrolling');
      await s.close();
    });
  }

  await t.test('GUIDED BUILDER end to end: type the answers, polish with nothing worth changing (free), then a real rewrite (charged once), then Restore', async () => {
    let mode = 'echo'; const sim = simServer({ parsed: parsedTaylor, polish: (r) => (mode === 'echo' ? echo(r) : rewriteFirst(r)), tailor: tailorSwap });
    const s = await open(sim, 'android');
    await s.page.click('#start-first'); await s.page.waitForSelector('#panel-guide .wiz-title');
    await s.page.focus('input[placeholder^="e.g. customer service"]'); await s.page.keyboard.type('Seeking a Retail Sales Associate position.', { delay: 4 });
    await s.page.click('.wiz-next'); assert.equal(await s.page.evaluate(() => state.data.summary.tagline), 'Seeking a Retail Sales Associate position');
    await s.page.evaluate((d) => { const keep = state.data.summary.tagline; state.data = JSON.parse(JSON.stringify(d)); state.data.summary.tagline = keep; Wiz.render(); renderPreview(); }, P.firstDetailed);
    await s.page.click('.wiz-dot:has-text("Review")');
    await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForFunction(() => !state.polish.busy); await s.page.waitForTimeout(150);
    assert.equal(sim.st.uses, 5); assert.match(await s.page.innerText('#polish-nochange'), /nothing meaningful|No meaningful improvements/i);
    mode = 'rewrite'; await s.page.click('#polish-btn'); await s.page.click('#polish-confirm'); await s.page.waitForFunction(() => !state.polish.busy); await s.page.waitForTimeout(150);
    assert.equal(sim.st.uses, 4); assert.equal(await s.page.locator('#polish-nochange').count(), 0, 'one outcome per attempt');
    await s.page.evaluate(() => Wiz.restoreAll()); assert.deepEqual(await s.page.evaluate(() => ResumeCore.clean(state.data).projects[0].bullets), Core.clean(P.firstDetailed).projects[0].bullets);
    await s.close();
  });

  await t.test('POLISH -> TAILOR -> edit after tailoring -> Polish again: tailoring is free, the edit survives, a no-change polish is free, Undo stays correct', async () => {
    let mode = 'rewrite'; const sim = simServer({ parsed: parsedTaylor, polish: (r) => (mode === 'echo' ? echo(r) : rewriteFirst(r)), tailor: (r) => ({ resume: (() => { const o = clone(r); o.summary.skills = [...o.summary.skills].reverse(); o.summary.tagline = 'Seeking a customer service position'; return o; })() }) });
    const s = await open(sim); await s.page.evaluate((d) => { state.data = JSON.parse(JSON.stringify(d)); renderEditFields(); renderPreview(); switchPanel('edit'); }, P.firstDetailed);
    await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); await s.page.waitForFunction(() => !state.polish.busy); await s.page.waitForTimeout(100); assert.equal(sim.st.uses, 4);
    await s.page.fill('#job-desc-input', 'Cashier for a food pantry. Customer service, teamwork.'); await s.page.click('#tailor-btn'); await s.page.waitForSelector('#match-summary-box', { state: 'visible' });
    assert.equal(sim.st.uses, 4, 'tailoring does not spend a generation'); assert.match(await badge(s), /4 of 5/);
    await s.page.evaluate(() => { state.data.projects[0].bullets[0] = 'Asked classmates to bring canned food to the school gym'; renderEditFields(); renderPreview(); });
    mode = 'echo'; await s.page.click('#edit-polish-btn'); await s.page.click('#edit-polish-confirm'); await s.page.waitForFunction(() => !state.polish.busy); await s.page.waitForTimeout(100);
    assert.equal(sim.st.uses, 4, 'nothing new to polish: free'); assert.equal(await s.page.evaluate(() => state.data.projects[0].bullets[0]), 'Asked classmates to bring canned food to the school gym');
    assert.match(sim.api['polish-resume'] && JSON.stringify(s.calls.filter((c) => c.name === 'polish-resume').pop().body.resume), /bring canned food to the school gym/, 'the new wording is what the AI is asked to polish');
    await s.close();
  });

  await t.test('DOUBLE CLICK and OVERLAP: two quick clicks send one request; Analyze and Tailor cannot start while Polish runs; one charge', async () => {
    const sim = simServer({ parsed: parsedTaylor, polish: rewriteFirst, tailor: tailorSwap }); const slow = sim.api['polish-resume']; sim.api['polish-resume'] = async (b) => { await new Promise((r) => setTimeout(r, 600)); return slow(b); };
    const s = await open(sim); await s.page.evaluate((d) => { state.data = JSON.parse(JSON.stringify(d)); renderEditFields(); renderPreview(); switchPanel('edit'); }, P.firstDetailed);
    await s.page.click('#edit-polish-btn'); await s.page.dblclick('#edit-polish-confirm'); await s.page.waitForFunction(() => state.aiBusy === 'polish');
    assert.equal(await s.page.evaluate(() => { tailorToJob(); Wiz.doPolish(); return document.getElementById('parse-btn').disabled; }), true);
    await s.page.waitForFunction(() => !state.aiBusy); assert.equal(sim.st.polishCalls, 1); assert.equal(sim.st.tailorCalls, 0); assert.equal(sim.st.uses, 4);
    await s.close();
  });
});
