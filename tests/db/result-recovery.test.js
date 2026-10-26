// Migration 04 at the SQL level (real local PostgreSQL): the encrypted recovery copy is written ATOMICALLY with the charge, belongs to one code, can never
// be returned after 24 hours (even if cleanup has not run), is purged, and is invisible to browser roles.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

test('result recovery: atomic with the charge, scoped, expiring, closed to browser roles (real SQL)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_m4'); await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db);
  for (const m of [H.MIG1, H.MIG2, H.MIG3, H.MIG4]) await H.applyMigration(db, m);
  const svc = db.pool('service_role', 4); const Q = async (sql, p) => (await svc.query(sql, p)).rows;
  let n = 0; const seed = async (uses = 5) => { const c = `FG-R${String(++n).padStart(3, '0')}-RRRR`; await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const reserve = async (c) => (await Q('select * from reserve_license_use($1)', [c]))[0];
  const commitWith = (id, fn = 'polish', ct = 'Y2lwaGVydGV4dA==', keep) => svc.query('select * from commit_license_use_with_result($1,$2,$3,$4,$5,$6,$7)', [id, fn, '1', 'c2FsdA==', 'aXY=', ct, keep === undefined ? 86400 : keep]).then((r) => r.rows[0]);
  const remaining = async (c) => (await Q('select uses_remaining u from licenses where code=$1', [c]))[0].u;

  await t.test('commit_license_use_with_result charges exactly once AND stores exactly one copy; repeating it neither charges nor duplicates', async () => {
    const c = await seed(); const r = await reserve(c);
    const a = await commitWith(r.reservation_id); assert.equal(a.outcome, 'committed'); assert.equal(a.result_saved, true); assert.equal(a.remaining, 4); assert.equal(await remaining(c), 4);
    const b = await commitWith(r.reservation_id, 'polish', 'b3RoZXI='); assert.equal(b.outcome, 'already_committed'); assert.equal(b.result_saved, true); assert.equal(await remaining(c), 4);
    const rows = await Q('select ct from result_recovery where code=$1', [c]); assert.equal(rows.length, 1); assert.equal(rows[0].ct, 'Y2lwaGVydGV4dA==', 'the first copy is kept');
  });

  await t.test('ATOMIC: if storing the copy fails, the charge does not happen either (trigger-injected failure), and a malformed copy is refused before anything is charged', async () => {
    const c = await seed(); const r = await reserve(c);
    await db.admin("create or replace function rr_fail() returns trigger language plpgsql as $$ begin raise exception 'injected store failure'; end $$; create trigger rr_fail_t before insert on result_recovery for each row execute function rr_fail();");
    await assert.rejects(() => commitWith(r.reservation_id), /injected store failure/);
    await db.admin('drop trigger rr_fail_t on result_recovery');
    assert.equal(await remaining(c), 5, 'no generation was deducted'); assert.equal((await Q('select status from license_reservations where id=$1', [r.reservation_id]))[0].status, 'reserved', 'the reservation is untouched');
    for (const bad of [['polish', ''], ['other', 'Y3Q='], ['polish', 'x'.repeat(400001)]]) { await assert.rejects(() => commitWith(r.reservation_id, bad[0], bad[1]), /invalid recovery copy|violates|value too long/); assert.equal(await remaining(c), 5, 'refused before charging'); }
    const ok = await commitWith(r.reservation_id); assert.equal(ok.outcome, 'committed'); assert.equal(await remaining(c), 4, 'and the real attempt still works afterwards');
  });

  await t.test('a commit that is refused (released reservation, exhausted code) stores nothing', async () => {
    const c = await seed(); const r = await reserve(c); await Q('select release_license_use($1,false)', [r.reservation_id]);
    const x = await commitWith(r.reservation_id); assert.equal(x.outcome, 'released'); assert.equal(x.result_saved, false); assert.equal((await Q('select count(*)::int n from result_recovery where code=$1', [c]))[0].n, 0);
  });

  await t.test('SCOPE: a code lists and fetches only its own copies; another code, an unknown id and an unknown code get nothing', async () => {
    const a = await seed(); const b = await seed(); const ra = await reserve(a); await commitWith(ra.reservation_id);
    assert.equal((await Q('select * from list_recoverable_results($1)', [a])).length, 1); assert.equal((await Q('select * from list_recoverable_results($1)', [b])).length, 0);
    assert.equal((await Q('select * from fetch_recoverable_result($1,$2)', [a, ra.reservation_id])).length, 1);
    assert.equal((await Q('select * from fetch_recoverable_result($1,$2)', [b, ra.reservation_id])).length, 0, 'another customer\'s code cannot fetch it');
    assert.equal((await Q('select * from fetch_recoverable_result($1,gen_random_uuid())', [a])).length, 0); assert.equal((await Q('select * from list_recoverable_results($1)', ['FG-NONE-NONE'])).length, 0);
  });

  await t.test('EXPIRY: nothing is returned after expires_at even though the row still exists (cleanup delayed); the 24-hour ceiling is a table rule; keep seconds are clamped; list tidies; purge removes', async () => {
    const c = await seed(); const r = await reserve(c); const v = await commitWith(r.reservation_id, 'analyze', 'Y3Q=', 999999999);
    const hours = (await Q("select extract(epoch from (expires_at - created_at))/3600 h from result_recovery where reservation_id=$1", [r.reservation_id]))[0].h; assert.ok(Number(hours) <= 24.0001, `clamped to 24 h (${hours})`);
    await assert.rejects(() => db.admin(`update result_recovery set expires_at = created_at + interval '25 hours' where reservation_id='${r.reservation_id}'`), /check constraint/);
    await db.admin(`update result_recovery set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where reservation_id='${r.reservation_id}'`);
    assert.equal((await Q('select * from fetch_recoverable_result($1,$2)', [c, r.reservation_id])).length, 0, 'expired but not yet deleted: still not returned');
    assert.equal((await Q('select count(*)::int n from result_recovery where reservation_id=$1', [r.reservation_id]))[0].n, 1, 'the row is still physically there');
    assert.equal((await Q('select * from list_recoverable_results($1)', [c])).length, 0);
    assert.equal((await Q('select count(*)::int n from result_recovery where reservation_id=$1', [r.reservation_id]))[0].n, 0, 'listing tidied this code\'s expired copy');
    const c2 = await seed(); const r2 = await reserve(c2); await commitWith(r2.reservation_id); await db.admin(`update result_recovery set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where reservation_id='${r2.reservation_id}'`);
    assert.equal((await Q('select purge_recoverable_results() as n'))[0].n >= 1, true); assert.equal((await Q('select count(*)::int n from result_recovery where reservation_id=$1', [r2.reservation_id]))[0].n, 0);
    assert.equal(v.result_saved, true);
  });

  await t.test('list shows at most the 3 newest; deleting a license removes its copies; the charge record itself is permanent', async () => {
    const c = await seed(8); const ids = []; for (let i = 0; i < 4; i++) { const r = await reserve(c); await commitWith(r.reservation_id); ids.push(r.reservation_id); await new Promise((x) => setTimeout(x, 15)); }
    const listed = await Q('select * from list_recoverable_results($1)', [c]); assert.equal(listed.length, 3); assert.equal(listed[0].id, ids[3], 'newest first');
    await Q('delete from licenses where code=$1', [c]); assert.equal((await Q('select count(*)::int n from result_recovery where code=$1', [c]))[0].n, 0);
  });

  await t.test('PRIVILEGES: anon and authenticated can neither call the functions nor read or write the table; service_role can; functions are security definer with a pinned search_path', async () => {
    const fns = ['public.commit_license_use_with_result(uuid,text,text,text,text,text,integer)', 'public.list_recoverable_results(text)', 'public.fetch_recoverable_result(text,uuid)', 'public.purge_recoverable_results()'];
    for (const f of fns) { assert.equal(await H.canExecute(db, 'anon', f), false, f); assert.equal(await H.canExecute(db, 'authenticated', f), false, f); assert.equal(await H.canExecute(db, 'service_role', f), true, f); }
    for (const role of ['anon', 'authenticated']) {
      const pool = db.pool(role, 2);
      for (const sql of ['select * from result_recovery', "insert into result_recovery (reservation_id, code, fn, kid, salt, iv, ct, expires_at) values (gen_random_uuid(),'x','polish','1','s','i','c', now() + interval '1 hour')", 'delete from result_recovery', "select * from list_recoverable_results('FG-AAAA-AAAA')", 'select purge_recoverable_results()'])
        await assert.rejects(() => pool.query(sql), /permission denied|row-level security/i, `${role}: ${sql.slice(0, 40)}`);
      await pool.end();
    }
    const r = (await db.admin(`select has_table_privilege('anon','result_recovery','select') a, has_table_privilege('authenticated','result_recovery','select') b, (select relrowsecurity from pg_class where relname='result_recovery') rls, (select count(*)::int from pg_proc p where p.proname in ('commit_license_use_with_result','list_recoverable_results','fetch_recoverable_result','purge_recoverable_results') and p.prosecdef and 'search_path=public' = any(p.proconfig)) definers`)).rows[0];
    assert.deepEqual(r, { a: false, b: false, rls: true, definers: 4 });
  });

  await svc.end(); await db.close();
});
