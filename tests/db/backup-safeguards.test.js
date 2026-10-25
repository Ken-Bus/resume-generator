// Safeguards of the production backup procedure, proven on a DISPOSABLE local PostgreSQL with FICTIONAL data (never Supabase):
//   1. one consistent database state (shared snapshot + reconciliation of the archive against the baseline; quiet-window mode refuses any change);
//   2. no plaintext customer data is left behind on failure, interruption, encryption problems or failed verification;
//   3. a backup is never reported usable before the restore check passes.
// Real pg_dump/openssl are wrapped by small shims that inject the failure (a balance change mid-dump, an ignored snapshot, a slow dump, a broken cipher).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execSync } = require('child_process');
const H = require('./helpers');

const ROOT = path.join(__dirname, '..', '..');
const BACKUP = path.join(ROOT, 'scripts', 'backup', 'backup-resume-db.sh');
const VERIFY = path.join(ROOT, 'scripts', 'backup', 'verify-restore-local.sh');
const PASS = 'test-passphrase-not-a-real-secret-123';
const REAL = { pg_dump: execSync('command -v pg_dump').toString().trim(), openssl: execSync('command -v openssl').toString().trim() };
const CODE_RE = /FG-[A-Z0-9]{3,4}-[A-Z0-9]{4}/;
const LOCALPG = { PGHOST: H.ADMIN.host, PGPORT: String(H.ADMIN.port), PGUSER: H.ADMIN.user, PGDATABASE: 'postgres', PGPASSWORD: 'unused' };

test('backup safeguards: consistency, plaintext cleanup, no false "usable" (fictional local data)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rgsg-')); t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const shim = path.join(out, 'shim'); fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, 'pg_dump'), `#!/bin/bash
[ "$1" = "--version" ] && exec "${REAL.pg_dump}" "$@"
[ -n "$RG_SHIM_MARK" ] && echo invoked >> "$RG_SHIM_MARK"
[ -n "$RG_SHIM_SQL" ] && psql -X -q -c "$RG_SHIM_SQL" >/dev/null
[ -n "$RG_SHIM_SLEEP" ] && sleep "$RG_SHIM_SLEEP"
args=(); for a in "$@"; do if [ "$RG_SHIM_STRIP_SNAPSHOT" = 1 ] && [[ "$a" == --snapshot=* ]]; then continue; fi; args+=("$a"); done
exec "${REAL.pg_dump}" "\${args[@]}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(shim, 'openssl'), `#!/bin/bash
if [ "$1" = "enc" ] && [ -n "$RG_SHIM_OPENSSL" ]; then
  case "$RG_SHIM_OPENSSL" in
    nopbkdf2) echo "openssl: unknown option -pbkdf2" >&2; exit 1;;
    failencrypt) echo x >> "$RG_SHIM_COUNT"; n=$(wc -l < "$RG_SHIM_COUNT"); if [ "$n" -ge 3 ] && [[ " $* " != *" -d "* ]]; then cat >/dev/null; echo "openssl: simulated failure" >&2; exit 1; fi;;   # the self-test runs encrypt and decrypt concurrently, so count with an atomic append
  esac
fi
exec "${REAL.openssl}" "$@"
`, { mode: 0o755 });

  let n = 0, counter = 0;
  async function source(name) {
    const db = await H.freshDatabase(name); await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db);
    for (const m of [H.MIG1, H.MIG2, H.MIG3, H.MIG4]) await H.applyMigration(db, m);
    for (let i = 0; i < 40; i++) await db.admin('insert into licenses(code,max_uses,uses_remaining,assigned,buyer_email) values ($1,5,$2,$3,$4)', [`FG-S${String(++n).padStart(3, '0')}-SSSS`, 5 - (i % 4), i % 3 !== 0, i % 3 !== 0 ? `person${n}@example.com` : null]);
    return db;
  }
  const envFor = (db, o, extra = {}) => ({ PATH: `${shim}:${process.env.PATH}`, HOME: process.env.HOME, PGHOST: H.ADMIN.host, PGPORT: String(H.ADMIN.port), PGUSER: H.ADMIN.user, PGDATABASE: db, PGPASSWORD: 'unused', PGAPPNAME: `rgsg-${++counter}`, RG_BACKUP_DIR: o, RG_BACKUP_PASSPHRASE: PASS, ...extra });
  const run = (script, env, args = []) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env, timeout: 120000 });
  const newOut = () => fs.mkdtempSync(path.join(out, 'o-'));
  const wd = () => fs.mkdtempSync(path.join(out, 'wd-'));
  const entries = (d) => fs.readdirSync(d);
  const files = (d) => entries(d).flatMap((e) => { const p = path.join(d, e); return fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((f) => path.join(e, f)) : [e]; });
  const noPlaintext = (d) => { const bad = files(d).filter((f) => !(f.endsWith('.tar.enc') || f.includes('.summary' + path.sep) || f.endsWith('.FAILED.txt'))); assert.deepEqual(bad, [], `plaintext or temp files left: ${bad.join(', ')}`); assert.deepEqual(entries(d).filter((e) => e.startsWith('rg-backup-work.') || e.startsWith('.work')), [], 'work folder removed'); };
  const sums = (summaryDir) => Object.fromEntries(fs.readFileSync(path.join(summaryDir, 'baseline_before.txt'), 'utf8').split('\n').filter(Boolean).map((l) => { const [k, key, ...v] = l.split('|'); return [`${k}|${key}`, v.join('|')]; }));
  const summaryOf = (d) => path.join(d, entries(d).find((e) => e.endsWith('.summary')));
  const encOf = (d) => path.join(d, entries(d).find((e) => e.endsWith('.tar.enc')));
  const PICK = "(select min(code) from licenses where uses_remaining > 0)";

  await t.test('CONSISTENCY: a license balance changes DURING the dump; the backup stays consistent as of the snapshot instant and restores to exactly that state', async () => {
    const db = await source('rg_sg_snap'); const before = (await db.admin('select sum(uses_remaining)::int s from licenses')).rows[0].s; const o = newOut();
    const r = run(BACKUP, envFor('rg_sg_snap', o, { RG_SHIM_SQL: `update licenses set uses_remaining = uses_remaining - 1 where code = ${PICK}` }));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal((await db.admin('select sum(uses_remaining)::int s from licenses')).rows[0].s, before - 1, 'the live database really changed mid-backup');
    const s = summaryOf(o); assert.equal(sums(s)['MUST|licenses.generations_remaining'], String(before), 'baseline = the snapshot instant, not the later state');
    const manifest = fs.readFileSync(path.join(s, 'manifest.txt'), 'utf8'); assert.match(manifest, /consistency: shared-snapshot/); assert.match(manifest, /snapshot_id_used: [0-9A-F-]+/); assert.match(manifest, /live database changed while the backup ran/);
    assert.match(r.stdout, /Reconciled/); assert.match(r.stdout, /NOT YET VERIFIED/);
    const v = run(VERIFY, envFor('postgres', o, { RG_WORKDIR: wd(), RG_WORKDIR_CONFIRMED: 'yes' }), [encOf(o)]); assert.equal(v.status, 0, v.stdout + v.stderr); assert.match(v.stdout, /RESULT: PASS/);
    assert.match(fs.readFileSync(path.join(s, 'verification.txt'), 'utf8'), /^RESULT: PASS/); noPlaintext(o);
  });

  await t.test('CONSISTENCY: if the snapshot is NOT honoured (simulated), the archive disagrees with the baseline and the backup is REJECTED with no plaintext left', async () => {
    await source('rg_sg_nosnap'); const o = newOut();
    const r = run(BACKUP, envFor('rg_sg_nosnap', o, { RG_SHIM_STRIP_SNAPSHOT: '1', RG_SHIM_SQL: `update licenses set uses_remaining = uses_remaining - 1 where code = ${PICK}` }));
    assert.notEqual(r.status, 0); assert.match(r.stderr, /DIFFERENT database states/); assert.match(r.stderr, /MISMATCH generations remaining/);
    assert.deepEqual(entries(o).filter((e) => e.endsWith('.tar.enc') || e.endsWith('.summary') || e.endsWith('.partial')), [], 'no backup file was produced'); noPlaintext(o);
    const note = fs.readFileSync(path.join(o, entries(o).find((e) => e.endsWith('.FAILED.txt'))), 'utf8'); assert.match(note, /failed_step: reconciling/); assert.equal(CODE_RE.test(note) || /@/.test(note) || note.includes(PASS), false, 'diagnostics hold no code, e-mail or secret');
  });

  await t.test('CONSISTENCY (quiet-window mode RG_NO_SNAPSHOT=1): any change during the backup is rejected, even one the row counts cannot see; an undisturbed run succeeds', async () => {
    await source('rg_sg_quiet'); let o = newOut();
    let r = run(BACKUP, envFor('rg_sg_quiet', o, { RG_NO_SNAPSHOT: '1', RG_SHIM_SQL: `update licenses set assigned = not assigned where code = ${PICK}` }));
    assert.notEqual(r.status, 0, 'a change that keeps every count equal is still caught by the before/after comparison'); assert.match(r.stderr, /changed while the backup ran/); noPlaintext(o);
    assert.deepEqual(entries(o).filter((e) => e.endsWith('.tar.enc')), []);
    o = newOut(); r = run(BACKUP, envFor('rg_sg_quiet', o, { RG_NO_SNAPSHOT: '1' })); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(fs.readFileSync(path.join(summaryOf(o), 'manifest.txt'), 'utf8'), /consistency: no-snapshot/); assert.match(r.stdout, /no changes while the backup ran/);
    const v = run(VERIFY, envFor('postgres', o, { RG_WORKDIR: wd(), RG_WORKDIR_CONFIRMED: 'yes' }), [encOf(o)]); assert.equal(v.status, 0, v.stdout + v.stderr);
  });

  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    await t.test(`INTERRUPTION (${sig}) mid-dump: exits non-zero, deletes the plaintext work folder, produces no backup file, and ends the snapshot session`, async () => {
      const db = await source(`rg_sg_int_${sig.toLowerCase()}`); const o = newOut(); const env = envFor(`rg_sg_int_${sig.toLowerCase()}`, o, { RG_SHIM_SLEEP: '30', RG_SHIM_MARK: path.join(o, '..', `mark-${sig}`) });
      const child = spawn('bash', [BACKUP], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let err = ''; child.stderr.on('data', (d) => { err += d; }); const exited = new Promise((res) => child.on('exit', (c, s) => res({ c, s })));
      const started = Date.now(); while (!fs.existsSync(env.RG_SHIM_MARK) && Date.now() - started < 30000) await new Promise((r) => setTimeout(r, 100));
      assert.ok(fs.existsSync(env.RG_SHIM_MARK), 'the dump had started'); assert.ok(entries(o).some((e) => e.startsWith('rg-backup-work.') || e.startsWith('.work')), 'plaintext work folder existed while running');
      const open = (await db.admin("select count(*)::int c from pg_stat_activity where application_name = $1 and state like 'idle in transaction%'", [env.PGAPPNAME])).rows[0].c; assert.equal(open, 1, 'the snapshot session was open during the dump');
      child.kill(sig); const res = await exited; assert.equal(res.c, code, `exit status ${JSON.stringify(res)} ${err}`); noPlaintext(o);
      assert.deepEqual(entries(o).filter((e) => e.endsWith('.tar.enc') || e.endsWith('.summary')), []); assert.match(err, /FAILED in step "pg_dump"/);
      await new Promise((r) => setTimeout(r, 500)); const left = (await db.admin('select count(*)::int c from pg_stat_activity where application_name = $1', [env.PGAPPNAME])).rows[0].c; assert.equal(left, 0, 'no database session of the backup remains');
    });
  }

  await t.test('ENCRYPTION CONFIG: missing passphrase, too-short passphrase, or a broken openssl STOP before any customer data is read (no dump, no files)', async () => {
    await source('rg_sg_enc1');
    for (const [label, extra, re] of [['no passphrase', { RG_BACKUP_PASSPHRASE: '' }, /no encryption passphrase/], ['short passphrase', { RG_BACKUP_PASSPHRASE: 'short' }, /at least 12 characters/], ['openssl lacks -pbkdf2', { RG_SHIM_OPENSSL: 'nopbkdf2' }, /cannot do AES-256 with -pbkdf2/]]) {
      const o = newOut(); const mark = path.join(o, '..', `m-${label.replace(/\W/g, '')}`); const r = run(BACKUP, envFor('rg_sg_enc1', o, { ...extra, RG_SHIM_MARK: mark }));
      assert.notEqual(r.status, 0, label); assert.match(r.stderr, re, label); assert.equal(fs.existsSync(mark), false, `${label}: pg_dump never ran`); assert.deepEqual(entries(o), [], `${label}: nothing written`);
    }
  });

  await t.test('ENCRYPTION FAILS AFTER THE DUMP: the plaintext is deleted, no .enc / .partial / summary remains, and the failure is reported plainly with masked diagnostics', async () => {
    await source('rg_sg_enc2'); const o = newOut(); const mark = path.join(o, '..', 'm-enc2'); const count = path.join(o, '..', 'c-enc2');
    const r = run(BACKUP, envFor('rg_sg_enc2', o, { RG_SHIM_OPENSSL: 'failencrypt', RG_SHIM_COUNT: count, RG_SHIM_MARK: mark }));
    assert.ok(fs.existsSync(mark), 'the dump had run, so plaintext existed'); assert.notEqual(r.status, 0); assert.match(r.stderr, /FAILED in step "encrypting"/); assert.match(r.stderr, /no plaintext was left behind/);
    assert.deepEqual(entries(o).filter((e) => e.endsWith('.tar.enc') || e.endsWith('.partial') || e.endsWith('.summary')), []); noPlaintext(o);
    const note = fs.readFileSync(path.join(o, entries(o).find((e) => e.endsWith('.FAILED.txt'))), 'utf8'); assert.match(note, /failed_step: encrypting/); assert.equal(CODE_RE.test(note) || /@/.test(note) || note.includes(PASS), false);
  });

  await t.test('FAILED VERIFICATION never looks like a usable backup: new backups say NOT YET VERIFIED; wrong passphrase, damage and a mismatching baseline all write RESULT: FAIL and leave no decrypted files', async () => {
    await source('rg_sg_ver'); const o = newOut(); const b = run(BACKUP, envFor('rg_sg_ver', o)); assert.equal(b.status, 0, b.stderr);
    const s = summaryOf(o); const marker = () => fs.readFileSync(path.join(s, 'verification.txt'), 'utf8');
    assert.match(b.stdout, /BACKUP CREATED, NOT YET VERIFIED/); assert.doesNotMatch(b.stdout, /\bDONE\b/); assert.match(marker(), /^RESULT: NOT YET VERIFIED/); assert.match(fs.readFileSync(path.join(s, 'manifest.txt'), 'utf8'), /status: NOT VERIFIED/);
    const tmp = path.join(out, `vt-${++counter}`); fs.mkdirSync(tmp);
    const vEnv = (extra = {}) => envFor('postgres', o, { RG_WORKDIR: tmp, RG_WORKDIR_CONFIRMED: 'yes', ...extra });
    let v = run(VERIFY, vEnv({ RG_BACKUP_PASSPHRASE: 'wrong-passphrase-123456' }), [encOf(o)]); assert.notEqual(v.status, 0); assert.match(v.stderr, /RESULT: FAIL \(could not decrypt/); assert.match(marker(), /^RESULT: FAIL/); assert.deepEqual(entries(tmp), [], 'no decrypted files left');
    const enc = encOf(o); const buf = fs.readFileSync(enc); const orig = Buffer.from(buf); buf[Math.floor(buf.length / 2)] ^= 0xff; fs.writeFileSync(enc, buf);
    v = run(VERIFY, vEnv(), [enc]); assert.notEqual(v.status, 0); assert.match(marker(), /^RESULT: FAIL/); assert.deepEqual(entries(tmp), []); fs.writeFileSync(enc, orig);
    v = run(VERIFY, vEnv(), [enc]); assert.equal(v.status, 0, v.stdout + v.stderr); assert.match(marker(), /^RESULT: PASS/); assert.match(marker(), /encrypted_file_sha256: [0-9a-f]{64}/); assert.deepEqual(entries(tmp), [], 'temp folder removed after success too');
    // a later failure overwrites an earlier PASS: the marker always reflects the LAST check
    v = run(VERIFY, vEnv({ RG_BACKUP_PASSPHRASE: 'wrong-passphrase-123456' }), [enc]); assert.notEqual(v.status, 0); assert.match(marker(), /^RESULT: FAIL/);
  });

  await t.test('NO RETENTION OPTIONS: RG_KEEP_PLAINTEXT and RG_KEEP_SCRATCH are gone; setting them changes nothing (no plaintext copy, scratch databases always dropped, even when verification fails)', async () => {
    for (const f of [BACKUP, VERIFY]) { const src = fs.readFileSync(f, 'utf8'); assert.equal(/RG_KEEP_PLAINTEXT|RG_KEEP_SCRATCH|plaintext-KEEP/.test(src), false, `${path.basename(f)} has no keep option`); }
    const db = await source('rg_sg_keep'); const o = newOut();
    const b = run(BACKUP, envFor('rg_sg_keep', o, { RG_KEEP_PLAINTEXT: '1' })); assert.equal(b.status, 0, b.stderr); noPlaintext(o); assert.deepEqual(entries(o).filter((e) => /KEEP|plaintext/i.test(e)), []);
    const w = wd(); let v = run(VERIFY, envFor('postgres', o, { RG_WORKDIR: w, RG_WORKDIR_CONFIRMED: 'yes', RG_KEEP_SCRATCH: '1' }), [encOf(o)]); assert.equal(v.status, 0, v.stdout + v.stderr);
    const left = async () => (await db.admin("select count(*)::int c from pg_database where datname ~ '^rg_restore_[ab]_'")).rows[0].c;
    assert.equal(await left(), 0, 'scratch databases dropped after a pass'); assert.deepEqual(entries(w), []);
    v = run(VERIFY, envFor('postgres', o, { RG_WORKDIR: w, RG_WORKDIR_CONFIRMED: 'yes', RG_KEEP_SCRATCH: '1', RG_BACKUP_PASSPHRASE: 'wrong-passphrase-123456' }), [encOf(o)]); assert.notEqual(v.status, 0);
    assert.equal(await left(), 0, 'and after a failure'); assert.deepEqual(entries(w), []);
  });

  await t.test('PRODUCTION NEEDS AN ENCRYPTED WORKSPACE: a Supabase-looking connection without RG_WORKDIR, with a missing folder, a folder inside the repository, or an unconfirmed folder is refused BEFORE the database is contacted', async () => {
    const o = newOut(); const base = { PATH: process.env.PATH, HOME: process.env.HOME, RG_BACKUP_DIR: o, RG_BACKUP_PASSPHRASE: PASS, PGPASSWORD: 'x', PGDATABASE: 'postgres', PGHOST: 'aws-0-us-east-1.pooler.supabase.com', PGUSER: 'postgres.mvtgifohlwlyedokiyhb' };
    const cases = [['no RG_WORKDIR', {}, /needs an ENCRYPTED temporary workspace/], ['missing folder', { RG_WORKDIR: path.join(out, 'does-not-exist') }, /not an existing writable folder/], ['inside the repository', { RG_WORKDIR: ROOT }, /must not be inside the repository/], ['unconfirmed folder', { RG_WORKDIR: wd() }, /encryption is not confirmed/]];
    for (const [label, extra, re] of cases) { const r = run(BACKUP, { ...base, ...extra }); assert.notEqual(r.status, 0, label); assert.match(r.stderr, re, label); assert.doesNotMatch(r.stderr, /could not connect/, `${label}: refused before connecting`); }
    assert.deepEqual(entries(o), [], 'nothing written'); const w = wd();
    let r = run(VERIFY, { PATH: process.env.PATH, HOME: process.env.HOME, ...LOCALPG, RG_BACKUP_PASSPHRASE: PASS }, ['/nonexistent.tar.enc']); assert.notEqual(r.status, 0); assert.match(r.stderr, /ENCRYPTED or RAM-backed workspace/);
    r = run(VERIFY, { PATH: process.env.PATH, HOME: process.env.HOME, ...LOCALPG, RG_BACKUP_PASSPHRASE: PASS, RG_WORKDIR: w }, ['/nonexistent.tar.enc']); assert.notEqual(r.status, 0); assert.match(r.stderr, /encryption is not confirmed/);
    r = run(VERIFY, { PATH: process.env.PATH, HOME: process.env.HOME, ...LOCALPG, RG_BACKUP_PASSPHRASE: PASS, RG_WORKDIR: w, RG_WORKDIR_CONFIRMED: 'yes' }, [o]); assert.notEqual(r.status, 0); assert.match(r.stderr, /unencrypted folders are not accepted/);
  });

  await t.test('WORKSPACE RECORDED: a RAM-backed folder is accepted automatically, an owner-confirmed one is recorded as such, and the plaintext lives ONLY in the workspace', async () => {
    await source('rg_sg_ws'); const o = newOut(); const w = wd(); const r = run(BACKUP, envFor('rg_sg_ws', o, { RG_WORKDIR: w, RG_WORKDIR_CONFIRMED: 'yes', RG_SHIM_SLEEP: '0.1' })); assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(summaryOf(o), 'manifest.txt'), 'utf8'), /workspace: owner confirmed an encrypted volume/); assert.deepEqual(entries(w), [], 'workspace emptied'); noPlaintext(o);
    const shm = '/dev/shm'; if (fs.existsSync(shm) && execSync(`stat -f -c %T ${shm}`).toString().trim() === 'tmpfs') {
      const ram = fs.mkdtempSync(path.join(shm, 'rgsg-')); t.after(() => fs.rmSync(ram, { recursive: true, force: true })); const o2 = newOut();
      const r2 = run(BACKUP, envFor('rg_sg_ws', o2, { RG_WORKDIR: ram })); assert.equal(r2.status, 0, r2.stderr); assert.match(fs.readFileSync(path.join(summaryOf(o2), 'manifest.txt'), 'utf8'), /workspace: RAM-backed \(tmpfs\)/);
    }
  });

  await t.test('SIGKILL CANNOT BE CLEANED UP, SO THE NEXT RUN REFUSES: a hard-killed backup leaves its folder ONLY inside the workspace; the next run stops without opening it, prints removal commands, and RG_DELETE_ABANDONED=yes then clears it', async () => {
    const db = await source('rg_sg_kill'); const o = newOut(); const w = wd(); const mark = path.join(o, '..', 'kill-mark');
    const env = envFor('rg_sg_kill', o, { RG_WORKDIR: w, RG_WORKDIR_CONFIRMED: 'yes', RG_SHIM_SLEEP: '30', RG_SHIM_MARK: mark });
    const child = spawn('bash', [BACKUP], { env, stdio: 'ignore', detached: true }); const exited = new Promise((res) => child.on('exit', res));
    const started = Date.now(); while (!fs.existsSync(mark) && Date.now() - started < 30000) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(mark)); process.kill(-child.pid, 'SIGKILL'); await exited; await new Promise((r) => setTimeout(r, 500));
    const abandoned = entries(w).filter((e) => e.startsWith('rg-backup-work.')); assert.equal(abandoned.length, 1, 'SIGKILL left the work folder (the limit that cannot be fixed in software)');
    assert.deepEqual(entries(o).filter((e) => e.startsWith('rg-backup-work.') || e.startsWith('.work')), [], 'and ONLY inside the workspace, never beside the backups');
    const r = run(BACKUP, { ...env, RG_SHIM_SLEEP: '' }); assert.notEqual(r.status, 0); assert.match(r.stderr, /did not finish cleanly/); assert.match(r.stderr, /Do NOT open or copy them/); assert.ok(r.stderr.includes(abandoned[0]), 'names the folder'); assert.match(r.stderr, /rm -rf/);
    assert.match(r.stderr, /No database was contacted/); assert.equal(entries(w).filter((e) => e.startsWith('rg-backup-work.')).length, 1, 'refusal does not touch or read it');
    const r2 = run(BACKUP, { ...env, RG_SHIM_SLEEP: '', RG_DELETE_ABANDONED: 'yes' }); assert.equal(r2.status, 0, r2.stderr); assert.match(r2.stdout, /Deleted abandoned work folder/); assert.deepEqual(entries(w), []);
    const open = (await db.admin("select count(*)::int c from pg_stat_activity where application_name = $1 and state like 'idle in transaction%'", [env.PGAPPNAME])).rows[0].c; assert.equal(open, 0, 'the killed run does not leave a snapshot session open');
  });

  await t.test('ABANDONED WORK FROM THE RESTORE CHECK: a leftover decrypted folder or scratch database stops the next verification (no contents shown); RG_DELETE_ABANDONED=yes clears them and the check then passes', async () => {
    const db = await source('rg_sg_abv'); const o = newOut(); const b = run(BACKUP, envFor('rg_sg_abv', o)); assert.equal(b.status, 0, b.stderr);
    const w = wd(); const left = path.join(w, 'rg-verify.abc123'); fs.mkdirSync(left); fs.writeFileSync(path.join(left, 'customer-data-file.sql'), 'FG-AAAA-BBBB buyer@example.com');
    await db.admin('create database rg_restore_a_424242');
    try {
      const vEnv = (x = {}) => envFor('postgres', o, { RG_WORKDIR: w, RG_WORKDIR_CONFIRMED: 'yes', ...x });
      let v = run(VERIFY, vEnv(), [encOf(o)]); assert.notEqual(v.status, 0); assert.match(v.stderr, /did not finish cleanly/); assert.ok(v.stderr.includes(left)); assert.match(v.stderr, /dropdb --force rg_restore_a_424242/);
      assert.equal(v.stderr.includes('customer-data-file') || v.stderr.includes('FG-AAAA') || v.stderr.includes('buyer@'), false, 'contents and file names are never shown'); assert.ok(fs.existsSync(left), 'refusal leaves it for the owner');
      v = run(VERIFY, vEnv({ RG_DELETE_ABANDONED: 'yes' }), [encOf(o)]); assert.equal(v.status, 0, v.stdout + v.stderr); assert.match(v.stdout, /Dropped abandoned scratch database: rg_restore_a_424242/); assert.equal(fs.existsSync(left), false); assert.match(v.stdout, /RESULT: PASS/);
    } finally { await db.admin('drop database if exists rg_restore_a_424242 with (force)'); }
  });

  await t.test('REGRESSION: wrong-project, transaction-pooler and remote-restore guards still refuse, and leave nothing behind', async () => {
    const o = newOut(); const base = { PATH: process.env.PATH, HOME: process.env.HOME, RG_BACKUP_DIR: o, RG_BACKUP_PASSPHRASE: PASS, PGPASSWORD: 'x', PGDATABASE: 'postgres' };
    let r = run(BACKUP, { ...base, PGHOST: 'aws-0-us-east-1.pooler.supabase.com', PGUSER: 'postgres.someotherprojectref' }); assert.notEqual(r.status, 0); assert.match(r.stderr, /not for project mvtgifohlwlyedokiyhb/);
    r = run(BACKUP, { ...base, PGHOST: 'aws-0-us-east-1.pooler.supabase.com', PGUSER: 'postgres.mvtgifohlwlyedokiyhb', PGPORT: '6543' }); assert.match(r.stderr, /transaction pooler/);
    r = run(VERIFY, { ...base, PGHOST: 'db.mvtgifohlwlyedokiyhb.supabase.co' }, ['/nonexistent']); assert.notEqual(r.status, 0); assert.match(r.stderr, /not local|refuses remote/);
    assert.deepEqual(entries(o), []);
  });
});
