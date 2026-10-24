// The standalone read-only SQL for migration 04 (docs/MIGRATION_04_PREFLIGHT.sql, docs/MIGRATION_04_POSTCHECK.sql) and the 03 + 04 deployment / rollback
// sequence, run against real local PostgreSQL 16 (never Supabase). Fictional data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const ROOT = path.join(__dirname, '..', '..');
const PRE = fs.readFileSync(path.join(ROOT, 'docs', 'MIGRATION_04_PREFLIGHT.sql'), 'utf8');
const POST = fs.readFileSync(path.join(ROOT, 'docs', 'MIGRATION_04_POSTCHECK.sql'), 'utf8');
const RB3 = fs.readFileSync(path.join(ROOT, 'supabase', 'rollback', '20261023_03_rollback.sql'), 'utf8');
const RB4 = fs.readFileSync(path.join(ROOT, 'supabase', 'rollback', '20261024_04_rollback.sql'), 'utf8');

// Run a script exactly as the owner would, but inside a READ ONLY transaction: any write attempt would raise an error and fail the test.
async function runReadOnly(db, sql) {
  const r = await db.admin(`begin read only;\n${sql}\ncommit;`);
  return Array.isArray(r) ? r : [r];
}
const verdictOf = async (db) => (await runReadOnly(db, POST)).find((x) => x.fields && x.fields.some((f) => f.name === 'verdict')).rows[0];
const stateOf = async (db) => (await runReadOnly(db, PRE)).find((x) => x.fields && x.fields.some((f) => f.name === 'database_state')).rows[0].database_state;

test('migration 04 preflight / post-check SQL and the 03 + 04 sequence (real PostgreSQL)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  let n = 0;
  async function build(name, migs) {
    const db = await H.freshDatabase(name); await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db);
    for (const m of migs) await H.applyMigration(db, m);
    for (let i = 0; i < 3; i++) await H.seed(db, [{ code: `FG-V${String(++n).padStart(3, '0')}-VVVV`, uses: 5, assigned: true }]);
    return db;
  }
  const balances = async (db) => (await db.admin(`select count(*)::int c, coalesce(sum(uses_remaining),0)::int r, md5(coalesce(string_agg(code||':'||uses_remaining||'/'||max_uses, ',' order by code),'')) fp from licenses`)).rows[0];

  await t.test('preflight: reports the right state and the prerequisites in every state, and never writes', async () => {
    const cases = [['rg_v4_c', [H.MIG1, H.MIG2], /^B\/C: migration 03 NOT applied/], ['rg_v4_d', [H.MIG1, H.MIG2, H.MIG3], /^D: migration 03 applied, 04 not applied/], ['rg_v4_e', [H.MIG1, H.MIG2, H.MIG3, H.MIG4], /^E: migration 04 already applied/]];
    for (const [name, migs, re] of cases) {
      const db = await build(name, migs); assert.match(await stateOf(db), re, name);
      const res = await runReadOnly(db, PRE); const pre = res.find((x) => x.fields && x.fields.some((f) => f.name === 'prerequisite')).rows;
      assert.equal(pre.length, 5); if (name !== 'rg_v4_c') assert.ok(pre.every((p) => p.present), `${name}: ${JSON.stringify(pre)}`);
      const coll = res.find((x) => x.fields && x.fields.some((f) => f.name === 'kind')).rows; assert.equal(coll.length, name === 'rg_v4_e' ? 7 : 0, `${name} collisions`);
      await db.close();
    }
  });

  await t.test('post-check: PASS on a correctly migrated database; before the migration it stops with "relation does not exist" (that is the FAIL signal); it never writes', async () => {
    const d = await build('rg_v4_pd', [H.MIG1, H.MIG2, H.MIG3]); await assert.rejects(() => runReadOnly(d, POST), /relation "public.result_recovery" does not exist/); await d.close();
    const e = await build('rg_v4_pe', [H.MIG1, H.MIG2, H.MIG3, H.MIG4]); const v = await verdictOf(e); assert.equal(v.verdict, 'PASS', JSON.stringify(v));
    const all = await runReadOnly(e, POST); const fn = all.find((x) => x.fields && x.fields.some((f) => f.name === 'search_path_pinned')).rows; assert.equal(fn.length, 4);
    for (const f of fn) assert.deepEqual([f.security_definer, f.search_path_pinned, f.anon, f.authenticated, f.public_execute, f.service_role], [true, true, false, false, false, true], f.proname);
    assert.equal(all.find((x) => x.fields && x.fields.some((f) => f.name === 'rows_for_a_code_that_cannot_exist')).rows[0].rows_for_a_code_that_cannot_exist, '0');
    await e.close();
  });

  await t.test('post-check CATCHES defects: browser role access, RLS off, service_role revoked, PUBLIC execute, missing function, missing 24 h rule, orphan copy, over-ceiling copy', async () => {
    const mk = () => build(`rg_v4_x${++n}`, [H.MIG1, H.MIG2, H.MIG3, H.MIG4]);
    const bad = [
      ['anon can read the table', 'grant select on result_recovery to anon', /anon or authenticated/],
      ['authenticated can write the table', 'grant insert on result_recovery to authenticated', /anon or authenticated/],
      ['RLS off', 'alter table result_recovery disable row level security', /row level security/],
      ['service_role revoked on the table', 'revoke all on result_recovery from service_role', /service_role cannot use/],
      ['PUBLIC may execute fetch', 'grant execute on function fetch_recoverable_result(text, uuid) to public', /not security definer|executable by/],
      ['anon may execute list', 'grant execute on function list_recoverable_results(text) to anon', /not security definer|executable by/],
      ['service_role cannot execute purge', 'revoke execute on function purge_recoverable_results() from service_role', /not security definer|executable by|not by service_role/],
      ['function missing', 'drop function purge_recoverable_results()', /functions? is missing/],
      ['24 h rule dropped', "alter table result_recovery drop constraint result_recovery_check", /24-hour ceiling/],
      ['03 object missing', 'drop function finish_redelivery(uuid, boolean)', /migration 03/],
    ];
    for (const [label, sql, re] of bad) {
      const db = await mk(); try { await db.admin(sql); } catch (e) { assert.fail(`${label}: setup failed: ${e.message}`); }
      const v = await verdictOf(db); assert.match(v.verdict, /^FAIL/, label); assert.match(v.verdict, re, `${label}: ${v.verdict}`); await db.close();
    }
    // orphan copy: a stored copy whose reservation was never committed
    const o = await mk(); const code = (await o.admin('select code from licenses limit 1')).rows[0].code; const svc = o.pool('service_role', 2);
    const r = (await svc.query('select * from reserve_license_use($1)', [code])).rows[0];
    await o.admin("insert into result_recovery(reservation_id, code, fn, kid, salt, iv, ct, expires_at) values ($1,$2,'polish','1','s','i','c', now() + interval '1 hour')", [r.reservation_id, code]);
    assert.match((await verdictOf(o)).verdict, /no committed charge/); await o.close();
  });

  await t.test('balances and reservations are untouched by every step of the 03 + 04 sequence, in both directions; each step is idempotent', async () => {
    const db = await build('rg_v4_seq', [H.MIG1, H.MIG2]); const base = await balances(db);
    const svc = db.pool('service_role', 2); const code = (await db.admin('select code from licenses order by code limit 1')).rows[0].code;
    await H.applyMigration(db, H.MIG3); assert.deepEqual(await balances(db), base); assert.match(await stateOf(db), /^D:/);
    const r = (await svc.query('select * from reserve_license_use($1)', [code])).rows[0]; await svc.query('select * from commit_license_use($1)', [r.reservation_id]);   // one real charge under 03
    const afterCharge = await balances(db); assert.equal(afterCharge.r, base.r - 1);
    const rsv = async () => (await db.admin("select count(*)::int n, count(*) filter (where status='committed')::int c from license_reservations")).rows[0];
    const rsv0 = await rsv();
    await H.applyMigration(db, H.MIG4); await H.applyMigration(db, H.MIG4);                       // 04 twice: idempotent
    assert.deepEqual(await balances(db), afterCharge); assert.deepEqual(await rsv(), rsv0); assert.equal((await verdictOf(db)).verdict, 'PASS');
    await db.admin(RB4); await db.admin(RB4);                                                   // rollback 04 first, twice: idempotent
    assert.deepEqual(await balances(db), afterCharge); assert.deepEqual(await rsv(), rsv0); assert.match(await stateOf(db), /^D:/);
    await db.admin(RB3); await db.admin(RB3);                                                   // then rollback 03: reverse order
    assert.deepEqual(await balances(db), afterCharge); assert.deepEqual(await rsv(), rsv0);
    assert.equal((await db.admin("select count(*)::int n from pg_proc where proname='reserve_license_use'")).rows[0].n, 1, 'one reserve function (the 5-argument original)');
    await H.applyMigration(db, H.MIG3); await H.applyMigration(db, H.MIG4);                       // and forward again: no data migration needed
    assert.deepEqual(await balances(db), afterCharge); assert.equal((await verdictOf(db)).verdict, 'PASS');
    await db.close();
  });

  await t.test('the WRONG rollback order is detected, not silent: rolling back 03 while 04 stays leaves a database the post-check marks FAIL, balances intact, and re-applying 03 repairs it', async () => {
    const db = await build('rg_v4_wrong', [H.MIG1, H.MIG2, H.MIG3, H.MIG4]); const base = await balances(db);
    await db.admin(RB3); assert.deepEqual(await balances(db), base);
    assert.match((await verdictOf(db)).verdict, /migration 03/); assert.equal((await db.admin("select count(*)::int n from pg_proc where proname='commit_license_use_with_result'")).rows[0].n, 1, '04 objects still present');
    await H.applyMigration(db, H.MIG3); assert.equal((await verdictOf(db)).verdict, 'PASS'); await db.close();
  });

  await t.test('04 can be applied on a database that lacks 03 (it needs only commit_license_use), but the preflight says 03 is missing and the checklist forbids that order', async () => {
    const db = await build('rg_v4_no03', [H.MIG1, H.MIG2]); assert.match(await stateOf(db), /03 NOT applied/);
    await H.applyMigration(db, H.MIG4); assert.match(await stateOf(db), /03 NOT applied/, 'preflight keeps warning'); assert.match((await verdictOf(db)).verdict, /migration 03/);
    await db.close();
  });
});
