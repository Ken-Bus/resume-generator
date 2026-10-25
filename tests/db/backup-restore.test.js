// The production backup procedure (scripts/backup/*.sh + docs/BACKUP_BASELINE.sql), proven end to end on a DISPOSABLE local PostgreSQL with FICTIONAL data:
// backup -> encrypt -> decrypt -> restore twice (pg_restore and psql schema+data) -> compare the baseline. Never touches Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const H = require('./helpers');

const ROOT = path.join(__dirname, '..', '..');
const BACKUP = path.join(ROOT, 'scripts', 'backup', 'backup-resume-db.sh');
const VERIFY = path.join(ROOT, 'scripts', 'backup', 'verify-restore-local.sh');
const PASS = 'test-passphrase-not-a-real-secret-123';
const sh = (script, env, args = []) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, timeout: 120000 });
const local = (db) => ({ PGHOST: H.ADMIN.host, PGPORT: String(H.ADMIN.port), PGUSER: H.ADMIN.user, PGDATABASE: db, PGPASSWORD: 'unused' });

test('production backup + restore-verification procedure (fictional local data)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rgbk-')); t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  let n = 0;
  async function source(name, migs, { supabaseLikeSchemaGrants = false } = {}) {
    const db = await H.freshDatabase(name); await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db);
    for (const m of migs) await H.applyMigration(db, m);
    if (supabaseLikeSchemaGrants) await db.admin('revoke all on schema public from public; grant usage on schema public to anon, authenticated, service_role;');
    for (let i = 0; i < 40; i++) await db.admin('insert into licenses(code,max_uses,uses_remaining,assigned,buyer_email) values ($1,5,$2,$3,$4)', [`FG-K${String(++n).padStart(3, '0')}-KKKK`, 5 - (i % 4), i % 3 !== 0, i % 3 !== 0 ? `customer${n}@example.com` : null]);
    if (migs.includes(H.MIG1)) {
      const svc = db.pool('service_role', 2); const codes = (await db.admin('select code from licenses order by code limit 6')).rows.map((r) => r.code);
      for (const [i, c] of codes.entries()) { const r = (await svc.query('select * from reserve_license_use($1)', [c])).rows[0]; if (i % 2 === 0) await svc.query('select * from commit_license_use($1)', [r.reservation_id]); }
      await svc.end();
    }
    await db.admin("create function public.rg_custom_probe() returns int language sql as 'select 42'; grant execute on function public.rg_custom_probe() to service_role;");
    return db;
  }
  const backup = (db, extra = {}) => { const d = fs.mkdtempSync(path.join(out, 'o-')); const r = sh(BACKUP, { ...local(db), RG_BACKUP_DIR: d, RG_BACKUP_PASSPHRASE: PASS, ...extra }); return { r, dir: d, enc: fs.readdirSync(d).find((f) => f.endsWith('.tar.enc')) && path.join(d, fs.readdirSync(d).find((f) => f.endsWith('.tar.enc'))) }; };
  const wd = fs.mkdtempSync(path.join(out, 'wd-'));          // stands in for the encrypted workspace the owner provides
  const verify = (enc, extra = {}) => sh(VERIFY, { ...local('postgres'), RG_BACKUP_PASSPHRASE: PASS, RG_WORKDIR: wd, RG_WORKDIR_CONFIRMED: 'yes', ...extra }, [enc]);
  // Open a finished backup, let the test change it, and seal it again (there is no option to keep plaintext, so tampering happens on a copy here).
  const repack = (enc, mutate) => {
    const t = fs.mkdtempSync(path.join(out, 'rp-')); const pw = { ...process.env, RG_BACKUP_PASSPHRASE: PASS };
    execFileSync('bash', ['-c', `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:RG_BACKUP_PASSPHRASE -in "${enc}" | tar -C "${t}" -xf -`], { env: pw });
    const folder = path.join(t, fs.readdirSync(t).find((f) => f.startsWith('resume-backup-'))); mutate(folder);
    const re = enc.replace(/\.tar\.enc$/, '.repacked.tar.enc');
    execFileSync('bash', ['-c', `tar -C "${t}" -cf - "$(basename "${folder}")" | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 -pass env:RG_BACKUP_PASSPHRASE -out "${re}"`], { env: pw });
    return re;
  };

  await t.test('backup then restore verifies PASS for production-shaped states (01+02), 03, and 03+04, including Supabase-style schema grants', async () => {
    for (const [name, migs, extra] of [['rg_bk_c', [H.MIG1, H.MIG2], {}], ['rg_bk_d', [H.MIG1, H.MIG2, H.MIG3], {}], ['rg_bk_e', [H.MIG1, H.MIG2, H.MIG3, H.MIG4], { supabaseLikeSchemaGrants: true }]]) {
      await source(name, migs, extra); const b = backup(name); assert.equal(b.r.status, 0, `${name} backup: ${b.r.stderr}${b.r.stdout}`); assert.ok(b.enc, 'one encrypted file');
      const v = verify(b.enc); assert.equal(v.status, 0, `${name} verify: ${v.stdout}${v.stderr}`); assert.match(v.stdout, /PASS \(A\)/); assert.match(v.stdout, /PASS \(B\)/); assert.match(v.stdout, /RESULT: PASS/);
    }
  });

  await t.test('PRIVACY: the encrypted file and the clear summary contain no license code, e-mail address or passphrase; the unencrypted dump folder is removed', async () => {
    await source('rg_bk_priv', [H.MIG1, H.MIG2, H.MIG3, H.MIG4]); const b = backup('rg_bk_priv'); assert.equal(b.r.status, 0, b.r.stderr);
    const enc = fs.readFileSync(b.enc); assert.equal(enc.includes('FG-K0'), false); assert.equal(enc.includes('@example.com'), false); assert.equal(enc.includes(PASS), false);
    const summary = fs.readdirSync(b.dir).filter((f) => f.endsWith('.summary')).map((f) => path.join(b.dir, f))[0]; const text = fs.readdirSync(summary).map((f) => fs.readFileSync(path.join(summary, f), 'utf8')).join('\n');
    assert.equal(/FG-[A-Z0-9]{3,4}-[A-Z0-9]{4}/.test(text), false, 'no license code in the clear summary'); assert.equal(/@/.test(text), false, 'no e-mail address in the clear summary'); assert.equal(text.includes(PASS), false);
    assert.deepEqual(fs.readdirSync(b.dir).filter((f) => f.startsWith('resume-backup-') && !f.endsWith('.enc') && !f.endsWith('.summary')), [], 'plaintext folder deleted');
    const stat = fs.statSync(b.enc).mode & 0o777; assert.equal(stat & 0o077, 0, 'file is private to the owner (0600)');
    assert.equal(/FG-[A-Z0-9]{3,4}-[A-Z0-9]{4}/.test(b.r.stdout + b.r.stderr), false, 'the script never prints a license code');
  });

  await t.test('a damaged or wrongly-keyed backup FAILS verification: flipped byte, wrong passphrase, tampered checksum list', async () => {
    await source('rg_bk_bad', [H.MIG1, H.MIG2, H.MIG3]); const b = backup('rg_bk_bad'); assert.equal(b.r.status, 0);
    const buf = fs.readFileSync(b.enc); buf[Math.floor(buf.length / 2)] ^= 0xff; const dmg = b.enc + '.damaged'; fs.writeFileSync(dmg, buf);
    assert.notEqual(verify(dmg).status, 0, 'flipped byte');
    const w = verify(b.enc, { RG_BACKUP_PASSPHRASE: 'wrong-passphrase-123456' }); assert.notEqual(w.status, 0); assert.match(w.stderr, /could not decrypt/);
    // data changed after the checksums were written (repacked and re-encrypted, so only the checksum can catch it)
    const tampered = repack(b.enc, (folder) => fs.appendFileSync(path.join(folder, 'data.sql'), '-- tampered\n')); const v = verify(tampered); assert.notEqual(v.status, 0); assert.match(v.stderr, /checksum mismatch/);
  });

  await t.test('the verification CATCHES a backup that no longer matches production: a changed balance in the baseline, a missing table row set', async () => {
    await source('rg_bk_diff', [H.MIG1, H.MIG2, H.MIG3, H.MIG4]); const k = backup('rg_bk_diff');
    const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    for (const [from, to] of [[/MUST\|licenses\.generations_remaining\|\d+/, 'MUST|licenses.generations_remaining|999'], [/MUST\|licenses\.fingerprint\|\w+/, 'MUST|licenses.fingerprint|00000000000000000000000000000000'], [/MUST\|reservations\.rows\|\d+/, 'MUST|reservations.rows|0'], [/MUST\|perms\.table_grants_hash\|\w+/, 'MUST|perms.table_grants_hash|x'], [/MUST\|schema\.functions_hash\|\w+/, 'MUST|schema.functions_hash|x'], [/MUST\|migration\.state\|[^\n]+/, 'MUST|migration.state|D: migration 03 applied, 04 not applied']]) {
      const re = repack(k.enc, (folder) => {                  // keep the checksum list valid so only the baseline comparison can fail
        const bl = path.join(folder, 'baseline_before.txt'); fs.writeFileSync(bl, fs.readFileSync(bl, 'utf8').replace(from, to));
        const sums = fs.readFileSync(path.join(folder, 'SHA256SUMS'), 'utf8'); fs.writeFileSync(path.join(folder, 'SHA256SUMS'), sums.replace(/^\w+(\s+baseline_before\.txt)$/m, `${sha(bl)}$1`));
      });
      const v = verify(re); assert.notEqual(v.status, 0, String(from)); assert.match(v.stdout, /FAIL \(A\)/);
    }
  });

  await t.test('GUARDS: wrong project, transaction pooler, pg_dump older than the server, a database that is not the Resume project, a remote restore target', async () => {
    const d = fs.mkdtempSync(path.join(out, 'g-')); const base = { RG_BACKUP_DIR: d, RG_BACKUP_PASSPHRASE: PASS, PGPASSWORD: 'x', PGDATABASE: 'postgres' };
    let r = sh(BACKUP, { ...base, PGHOST: 'aws-0-us-east-1.pooler.supabase.com', PGUSER: 'postgres.someotherprojectref' }); assert.notEqual(r.status, 0); assert.match(r.stderr, /not for project mvtgifohlwlyedokiyhb/);
    r = sh(BACKUP, { ...base, PGHOST: 'aws-0-us-east-1.pooler.supabase.com', PGUSER: 'postgres.mvtgifohlwlyedokiyhb', PGPORT: '6543' }); assert.notEqual(r.status, 0); assert.match(r.stderr, /transaction pooler/);
    const shim = fs.mkdtempSync(path.join(out, 'shim-')); fs.writeFileSync(path.join(shim, 'pg_dump'), '#!/bin/sh\necho "pg_dump (PostgreSQL) 12.1"\n', { mode: 0o755 });
    await source('rg_bk_ver', [H.MIG1, H.MIG2]); r = sh(BACKUP, { ...local('rg_bk_ver'), RG_BACKUP_DIR: d, RG_BACKUP_PASSPHRASE: PASS, PATH: `${shim}:${process.env.PATH}` }); assert.notEqual(r.status, 0); assert.match(r.stderr, /OLDER than the server/);
    const other = await H.freshDatabase('rg_bk_other'); await other.admin('create table unrelated(id int)'); r = sh(BACKUP, { ...local('rg_bk_other'), RG_BACKUP_DIR: d, RG_BACKUP_PASSPHRASE: PASS }); assert.notEqual(r.status, 0); assert.match(r.stderr, /not the Resume project/);
    r = sh(VERIFY, { PGHOST: 'db.mvtgifohlwlyedokiyhb.supabase.co', PGPASSWORD: 'x', RG_BACKUP_PASSPHRASE: PASS }, ['/nonexistent']); assert.notEqual(r.status, 0); assert.match(r.stderr, /not local|refuses remote/);
    assert.deepEqual(fs.readdirSync(d), [], 'a refused run leaves no files behind');
  });
});
