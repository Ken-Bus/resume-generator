// The release run: the whole suite, and it REFUSES to report success if anything was skipped or if the infrastructure that makes the suite
// meaningful (a real local Postgres, a real Chromium) is missing. `npm test` stays the quick developer run; `npm run test:release` is the gate.
const fs = require('fs');
const { spawnSync } = require('child_process');
const H = require('./db/helpers');
const browser = require('./ui/browser');

(async () => {
  const blocked = [];
  if (!(await H.available())) blocked.push('no local Postgres is reachable (tests/README.md says how to start one): the database-backed tests would be skipped');
  if (!fs.existsSync(browser.PW) || !fs.existsSync(browser.CHROME)) blocked.push(`Playwright/Chromium not found (${browser.PW} / ${browser.CHROME}): the browser tests would be skipped`);
  if (blocked.length) { console.error(`RELEASE RUN BLOCKED:\n - ${blocked.join('\n - ')}`); process.exit(2); }
  const r = spawnSync('node', ['--test', '--test-concurrency=1', 'core/*.test.js', 'db/*.test.js', 'functions/*.test.js', 'ui/*.test.js'],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, REQUIRE_BROWSER: '1' } });
  const out = `${r.stdout || ''}`;
  const n = (k) => Number((new RegExp(`^# ${k} (\\d+)`, 'm').exec(out) || [0, 0])[1]);
  const total = { tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: n('skipped'), cancelled: n('cancelled') };
  const skips = [...out.matchAll(/^\s*ok \d+ - (.*?) # SKIP (.*)$/gm)].map((m) => `${m[1]} (${m[2]})`);
  console.log(`RELEASE RUN: ${total.pass} passed, ${total.fail} failed, ${total.skipped} skipped, ${total.cancelled} cancelled, of ${total.tests}`);
  if (r.status !== 0 || total.fail || total.cancelled || total.skipped) {
    if (skips.length) console.error(`SKIPPED (not allowed in a release run):\n - ${skips.join('\n - ')}`);
    const bad = [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
    if (bad.length) console.error(`FAILED:\n - ${bad.join('\n - ')}`);
    process.exit(1);
  }
})();
