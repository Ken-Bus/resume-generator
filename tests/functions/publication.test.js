// What the internet can download. netlify.toml publishes the repository root (`publish = "."`), so every tracked file is public unless a
// rule says otherwise. These tests make that explicit: only the customer page is public, everything else is answered with a 404, and a new
// file cannot be added without somebody deciding which of the two it is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
const PUBLIC_FILES = new Set(['index.html', 'wizard.js', 'resume-core.js', 'templates.js', '404.html']);

// Minimal reader for the two kinds of blocks netlify.toml uses here.
const redirects = [...toml.matchAll(/\[\[redirects\]\]\s*\n([\s\S]*?)(?=\n\[\[|\n\[|$)/g)].map((m) => {
  const get = (k) => (new RegExp(`^\\s*${k}\\s*=\\s*"?([^"\\n]+)"?\\s*$`, 'm').exec(m[1]) || [])[1];
  return { from: get('from'), to: get('to'), status: get('status'), force: get('force') };
});
const headerBlock = toml.slice(toml.indexOf('[[headers]]'));
const header = (name) => { const m = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm').exec(headerBlock); return m && m[1]; };

const blocked = (file) => redirects.some((r) => {
  if (r.from.endsWith('/*')) return ('/' + file).startsWith(r.from.slice(0, -1));
  return '/' + file === r.from;
});
const tracked = () => execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

test('every tracked file is either one of the five public files or blocked with a forced 404 (nothing leaks by default)', () => {
  const leaks = tracked().filter((f) => !PUBLIC_FILES.has(f) && !blocked(f));
  assert.deepEqual(leaks, [], `these files would be downloadable: ${leaks.join(', ')}`);
  for (const f of PUBLIC_FILES) assert.equal(fs.existsSync(path.join(ROOT, f)), true, `${f} must exist`);
});

test('the blocking rules really block: forced, a 404 status, pointing at the public 404 page; the public files are never blocked', () => {
  assert.ok(redirects.length >= 10);
  for (const r of redirects) { assert.equal(r.status, '404', r.from); assert.equal(r.force, 'true', `${r.from} must be forced or the real file would still be served`); assert.equal(r.to, '/404.html', r.from); }
  for (const f of PUBLIC_FILES) assert.equal(blocked(f), false, `${f} must stay public`);
  assert.equal(blocked('templates.js'), false);                  // /templates/* (delivery instructions) is blocked, /templates.js (the page's template list) is not
  assert.equal(blocked('templates/delivery-instructions.html'), true);
  for (const f of ['netlify/functions/polish-resume.js', 'netlify/functions/_lib/integrity.js', 'supabase/schema.sql', 'scripts/generate-codes.js', 'lib/codes.js', 'docs/AI_POLISH.md', 'tests/functions/polish.test.js', 'SETUP.md', 'package.json', 'netlify.toml'])
    assert.equal(blocked(f), true, `${f} must be blocked`);
});

test('security headers: clickjacking, sniffing, referrer, device permissions and a content security policy that allows only this site', () => {
  assert.equal(header('X-Frame-Options'), 'DENY'); assert.equal(header('X-Content-Type-Options'), 'nosniff');
  assert.equal(header('Referrer-Policy'), 'strict-origin-when-cross-origin');
  assert.match(header('Permissions-Policy'), /camera=\(\)/); assert.match(header('Permissions-Policy'), /microphone=\(\)/); assert.match(header('Permissions-Policy'), /geolocation=\(\)/);
  const csp = header('Content-Security-Policy');
  for (const must of ["default-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) assert.ok(csp.includes(must), must);
  assert.equal(/unsafe-eval|\*|http:|data:\s*;?[^;]*script/i.test(csp.replace(/https:\/\/fonts\.(googleapis|gstatic)\.com/g, '')), false, 'no eval, wildcards, plain http, or data: scripts');
  assert.deepEqual([...csp.matchAll(/https:\/\/[a-z.]+/g)].map((m) => m[0]).sort(), ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']);   // the only third-party hosts
});

test('the public files contain no secrets, keys, license codes or internal addresses', () => {
  const banned = [/sb_secret/i, /service_role/i, /sk-ant/i, /ANTHROPIC_API_KEY/, /TAILOR_TOKEN_SECRET/, /eyJ[A-Za-z0-9_-]{20,}/, /\bFG-[A-Z0-9]{4}-[A-Z0-9]{4}\b/, /supabase\.co/i, /@gmail\.com/i];
  for (const f of PUBLIC_FILES) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const re of banned) { const m = re.exec(text); if (m && !(re.source.includes('FG-') && /FG-XXXX-XXXX/.test(m[0]))) assert.fail(`${f} contains ${re}`); }
  }
});

test('the public page does not pull in anything from a blocked path', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs.sort(), ['/resume-core.js', '/templates.js', '/wizard.js']);
  for (const s of srcs) assert.equal(blocked(s.slice(1)), false, s);
  assert.equal(/\bsrc="https?:/i.test(html), false, 'no third-party scripts or images');
});
