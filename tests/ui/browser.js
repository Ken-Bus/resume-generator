// Finds Playwright and Chromium for the browser tests. A hard-coded Chromium build number used to make every browser suite SKIP silently
// (and look green) on a machine with a different build. Now the newest installed build is used; set CHROMIUM_PATH / PLAYWRIGHT_MODULE to
// override, and set REQUIRE_BROWSER=1 (done by `npm run test:release`) to make a missing browser a FAILURE instead of a skip.
const fs = require('fs');
const path = require('path');
const os = require('os');

function findChrome() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    let dirs = []; try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)); } catch (e) { continue; }
    dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) for (const sub of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
      const f = path.join(root, d, sub); if (fs.existsSync(f)) return f;
    }
  }
  return '/opt/pw-browsers/chromium/chrome-linux/chrome';
}
function findPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return process.env.PLAYWRIGHT_MODULE;
  for (const p of ['/opt/node-tools/node_modules/playwright']) if (fs.existsSync(p)) return p;
  try { return path.dirname(require.resolve('playwright/package.json')); } catch (e) { return '/opt/node-tools/node_modules/playwright'; }
}
const PW = findPlaywright();
const CHROME = findChrome();

// true when the browser tests cannot run (and the test was skipped); throws instead when a browser is required.
function unavailable(t) {
  if (fs.existsSync(PW) && fs.existsSync(CHROME)) return false;
  if (process.env.REQUIRE_BROWSER === '1') throw new Error(`Playwright/Chromium required (REQUIRE_BROWSER=1) but not found: ${PW} / ${CHROME}`);
  t.skip('Playwright/Chromium not available');
  return true;
}
module.exports = { PW, CHROME, unavailable };
