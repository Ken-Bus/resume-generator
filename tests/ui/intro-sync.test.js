// Guided Builder step 1: "Work you're looking for" fills "One-line introduction". Regression tests for the doubled
// "Seeking a Seeking a S position" found in the Android acceptance test. Fictional text only; every endpoint is mocked; no AI calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { PW, CHROME, unavailable } = require('./browser');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const BAD = /seeking.*seeking|\b(a|an) (a|an)\b|position position|\bposition\b.*\bposition\b/i;

function serve() {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

test('Guided Builder step 1: role field and one-line intro stay in sync without duplicating or overwriting', async (t) => {
  if (unavailable(t)) return;
  const { chromium } = require(PW);
  const server = await serve(); const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(async () => { await browser.close(); server.close(); });

  const ROLE = 'input[placeholder^="e.g. customer service"]';
  const INTRO = '#wiz-tagline';
  const layouts = {
    desktop: { viewport: { width: 1280, height: 900 } },
    android: { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' },
    androidSmall: { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true },
  };

  async function open(layout) {
    const ctx = await browser.newContext(layouts[layout]); const page = await ctx.newPage();
    const errors = []; const calls = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.includes('/.netlify/functions/')) {
        const name = url.split('/.netlify/functions/')[1]; if (name !== 'recover-result') calls.push(name);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, usesRemaining: 5, maxUses: 5 }) });
      }
      if (url.startsWith(base)) return route.continue();
      return route.abort();
    });
    await page.goto(base + '/index.html');
    await page.fill('#gate-code-input', 'FG-TEST-AAAA'); await page.click('#gate-unlock-btn');
    await page.waitForSelector('#license-gate', { state: 'hidden' });
    await page.click('#start-first'); await page.waitForSelector('#panel-guide .wiz-title');
    await page.waitForSelector(ROLE);
    return { page, calls, errors, close: () => ctx.close() };
  }
  const intro = (s) => s.page.inputValue(INTRO);
  const stored = (s) => s.page.evaluate(() => state.data.summary.tagline);
  // Type like a person, and record the intro after every key so a transient bad value cannot hide.
  async function typeAndWatch(s, selector, text) {
    await s.page.focus(selector);
    const seen = [];
    for (const ch of text) { await s.page.keyboard.type(ch, { delay: 5 }); seen.push(await intro(s)); seen.push(await stored(s)); }
    return seen;
  }
  const settle = (s) => s.page.waitForTimeout(950);

  for (const layout of Object.keys(layouts)) {
    await t.test(`[${layout}] typing a full phrase never shows a doubled or partial intro, and settles to one clean sentence`, async () => {
      const s = await open(layout);
      const seen = await typeAndWatch(s, ROLE, 'Seeking a Retail Sales Associate position.');
      for (const v of seen) { assert.doesNotMatch(v, BAD, `transient value: ${v}`); assert.ok(v === '' || /^Seeking an? .+ position$/.test(v), `no partial sentence: ${v}`); }
      await settle(s);
      assert.equal(await intro(s), 'Seeking a Retail Sales Associate position');
      assert.equal(await stored(s), 'Seeking a Retail Sales Associate position');
      assert.match(await s.page.innerText('#resume-preview'), /Seeking a Retail Sales Associate position/);
      assert.equal(await s.page.inputValue(ROLE), 'Seeking a Retail Sales Associate position.', 'the customer\'s own words in the role box are never rewritten');
      assert.deepEqual(s.errors, []); assert.deepEqual(s.calls.filter((c) => c !== 'verify-license'), [], 'no paid or other calls');
      await s.close();
    });

    await t.test(`[${layout}] typing a plain job title still autofills`, async () => {
      const s = await open(layout);
      const seen = await typeAndWatch(s, ROLE, 'Retail Sales Associate');
      for (const v of seen) assert.ok(v === '' || /^Seeking an? .+ position$/.test(v), `no partial sentence: ${v}`);
      await settle(s);
      assert.equal(await intro(s), 'Seeking a Retail Sales Associate position');
      await s.close();
    });

    await t.test(`[${layout}] pasting a phrase or a title fills at once, once`, async () => {
      const s = await open(layout);
      const paste = (text) => s.page.evaluate(([sel, v]) => { const el = document.querySelector(sel); el.focus(); el.value = v; el.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', data: v, bubbles: true })); }, [ROLE, text]);
      await paste('Seeking a Seeking a Cashier position.');
      assert.equal(await intro(s), 'Seeking a Cashier position');
      await paste('Looking for a job as an office assistant');
      assert.equal(await intro(s), 'Seeking an office assistant position', 'own autofill follows a changed role');
      await paste('warehouse associate');
      assert.equal(await intro(s), 'Seeking a warehouse associate position');
      await s.close();
    });

    await t.test(`[${layout}] deleting: clearing the role clears our autofill; deleting part of it settles to a clean sentence`, async () => {
      const s = await open(layout);
      await s.page.fill(ROLE, 'Retail Sales Associate');
      assert.equal(await intro(s), 'Seeking a Retail Sales Associate position');
      await s.page.focus(ROLE); await s.page.keyboard.press('End');
      for (let i = 0; i < 'Associate'.length; i++) { await s.page.keyboard.press('Backspace'); assert.doesNotMatch(await intro(s), BAD); }
      await settle(s);
      assert.equal(await intro(s), 'Seeking a Retail Sales position');
      await s.page.keyboard.press('Control+A'); await s.page.keyboard.press('Backspace');
      await settle(s);
      assert.equal(await intro(s), '', 'role cleared -> our own intro cleared');
      assert.equal(await stored(s), '');
      assert.doesNotMatch(await s.page.innerText('#resume-preview'), /Seeking/);
      await s.close();
    });

    await t.test(`[${layout}] changing the desired role updates our own autofill each time, no leftovers`, async () => {
      const s = await open(layout);
      for (const [role, want] of [['cashier', 'Seeking a cashier position'], ['Warehouse Associate', 'Seeking a Warehouse Associate position'], ['Seeking an Office Assistant role', 'Seeking an Office Assistant position'], ['barista', 'Seeking a barista position']]) {
        await s.page.fill(ROLE, role);
        assert.equal(await intro(s), want, role);
      }
      await s.close();
    });

    await t.test(`[${layout}] a customer's own introduction is never overwritten, and the fields stay independent`, async () => {
      const s = await open(layout);
      await s.page.fill(ROLE, 'cashier');
      assert.equal(await intro(s), 'Seeking a cashier position');
      await s.page.fill(INTRO, 'Friendly student looking for a part-time retail job');       // manual edit
      assert.equal(await s.page.inputValue(ROLE), 'cashier', 'editing the intro does not touch the role');
      await s.page.fill(ROLE, 'Retail Sales Associate'); await settle(s);
      assert.equal(await intro(s), 'Friendly student looking for a part-time retail job', 'role change leaves a customer-written intro alone');
      await s.page.fill(ROLE, ''); await settle(s);
      assert.equal(await intro(s), 'Friendly student looking for a part-time retail job', 'clearing the role leaves it alone too');
      assert.equal(await stored(s), 'Friendly student looking for a part-time retail job');
      // a small manual tweak of OUR text also counts as the customer's own writing
      await s.page.fill(ROLE, 'cashier');
      await s.page.fill(INTRO, ''); await s.page.fill(ROLE, 'barista'); await settle(s);
      assert.equal(await intro(s), 'Seeking a barista position', 'an emptied intro autofills again');
      await s.page.fill(INTRO, 'Seeking a barista position, weekends'); await s.page.fill(ROLE, 'cashier'); await settle(s);
      assert.equal(await intro(s), 'Seeking a barista position, weekends');
      await s.close();
    });

    await t.test(`[${layout}] pressing Next straight after typing applies the pending autofill, and Back shows it`, async () => {
      const s = await open(layout);
      await s.page.focus(ROLE); await s.page.keyboard.type('Seeking a Nursing Assistant position', { delay: 3 });
      await s.page.click('.wiz-next');
      assert.equal(await stored(s), 'Seeking a Nursing Assistant position');
      await s.page.click('.wiz-back'); await s.page.waitForSelector(INTRO);
      assert.equal(await intro(s), 'Seeking a Nursing Assistant position');
      assert.equal(await s.page.inputValue(ROLE), 'Seeking a Nursing Assistant position');
      await s.close();
    });

    await t.test(`[${layout}] layout: both fields visible, usable-size, no sideways scrolling, nothing hidden by the button bar`, async () => {
      const s = await open(layout);
      await s.page.fill(ROLE, 'Seeking a Retail Sales Associate position.');
      const m = await s.page.evaluate(([r, i]) => {
        const box = (sel) => { const e = document.querySelector(sel); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, h: b.height, fs: parseFloat(getComputedStyle(e).fontSize) }; };
        return { role: box(r), intro: box(i), vw: window.innerWidth, scrollW: document.documentElement.scrollWidth, bodyW: document.body.scrollWidth };
      }, [ROLE, INTRO]);
      for (const f of [m.role, m.intro]) { assert.ok(f.l >= 0 && f.r <= m.vw + 0.5, `inside the screen (${f.l}-${f.r} of ${m.vw})`); if (layout !== 'desktop') { assert.ok(f.fs >= 16, 'no zoom-on-focus font size'); assert.ok(f.h >= 36, 'tap size'); } }
      assert.ok(m.scrollW <= m.vw + 1 && m.bodyW <= m.vw + 1, 'no horizontal scroll');
      assert.equal(await intro(s), 'Seeking a Retail Sales Associate position');
      await s.close();
    });
  }
});
