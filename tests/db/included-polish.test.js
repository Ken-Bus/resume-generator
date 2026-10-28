// Migration 05 at the SQL level (real local PostgreSQL, never Supabase): one included AI Polish per paid Analyze, claimed atomically and only once,
// usable with zero generations left, never expiring, never touched by a failed or lapsed attempt; plus the read-only 96-hour access state, the
// compatibility with the currently deployed calls, and the rollback. Fictional codes only; no AI is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

test('included polish (migration 05): atomic, one-time, zero-balance safe, non-expiring, compatible, reversible (real SQL)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_m5'); await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db);
  for (const m of [H.MIG1, H.MIG2, H.MIG3, H.MIG4]) await H.applyMigration(db, m);
  const before = await H.fingerprint(db);
  await H.applyMigration(db, H.MIG5);
  const svc = db.pool('service_role', 12); const Q = async (sql, p) => (await svc.query(sql, p)).rows;
  let n = 0; const seed = async (uses = 5) => { const c = `FG-I${String(++n).padStart(3, '0')}-IIII`; await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const reserve = async (c, allow = false, key = null, hash = null) => (await Q('select * from reserve_license_use($1,45,900,6,30,$2,$3,$4)', [c, key, hash, allow]))[0];
  const commitWith = (id, fn = 'polish', ct = 'Y2lwaGVydGV4dA==') => svc.query('select * from commit_license_use_with_result($1,$2,$3,$4,$5,$6,$7)', [id, fn, '1', 'c2FsdA==', 'aXY=', ct, 86400]).then((r) => r.rows[0]);
  const remaining = async (c) => (await Q('select uses_remaining u from licenses where code=$1', [c]))[0].u;
  const row = async (id) => (await Q('select * from license_reservations where id=$1', [id]))[0];
  const status = async (c, hours) => (await Q('select * from license_access_status($1,$2)', [c, hours === undefined ? 96 : hours]))[0];
  // A paid Analyze: reserve (no included polish asked) and commit through the new path.
  const analyze = async (c) => { const r = await reserve(c); assert.equal(r.outcome, 'reserved'); const k = await commitWith(r.reservation_id, 'analyze'); assert.equal(k.outcome, 'committed'); return r.reservation_id; };

  await t.test('the migration is purely additive: no balance or code changed, and it can be applied again', async () => {
    assert.deepEqual(await H.fingerprint(db), before);
    await H.applyMigration(db, H.MIG5); await H.applyMigration(db, H.MIG5);
    assert.deepEqual(await H.fingerprint(db), before);
    const f = await Q(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public' and p.proname='reserve_license_use'`);
    assert.equal(f[0].n, 1, 'exactly one reserve_license_use exists (no ambiguous overloads)');
  });

  await t.test('an Analyze records its kind and carries exactly one included polish; nothing else does', async () => {
    const c = await seed(); const a = await analyze(c);
    assert.equal((await row(a)).kind, 'analyze'); assert.equal(await remaining(c), 4);
    const s = await status(c); assert.equal(s.included_available, 1); assert.equal(s.access_state, 'active');
    const p = await reserve(c); await commitWith(p.reservation_id, 'polish');                       // an ordinary paid Polish creates no credit
    assert.equal((await status(c)).included_available, 1); assert.equal(await remaining(c), 3);
    const old = await seed(); const r = await reserve(old); await Q('select * from commit_license_use($1)', [r.reservation_id]);   // committed the old way: kind unknown
    assert.equal((await row(r.reservation_id)).kind, null); assert.equal((await status(old)).included_available, 0, 'no retroactive credit');
  });

  await t.test('only a Polish that ASKS can use it; Analyze and the default call never do', async () => {
    const c = await seed(); const a = await analyze(c);
    const plain = await reserve(c, false); assert.equal(plain.outcome, 'reserved'); assert.equal(plain.included_from, null);
    await Q('select release_license_use($1,false)', [plain.reservation_id]);
    const asked = await reserve(c, true); assert.equal(asked.outcome, 'reserved'); assert.equal(asked.included_from, a);
  });

  await t.test('an included Polish commits WITHOUT taking a generation, claims the credit once, and keeps the encrypted copy', async () => {
    const c = await seed(); const a = await analyze(c); assert.equal(await remaining(c), 4);
    const r = await reserve(c, true); const k = await commitWith(r.reservation_id);
    assert.equal(k.outcome, 'committed'); assert.equal(k.included, true); assert.equal(k.included_from, a); assert.equal(k.remaining, 4); assert.equal(k.result_saved, true);
    assert.equal(await remaining(c), 4, 'the balance did not move'); assert.equal((await row(a)).included_polish_by, r.reservation_id); assert.equal((await row(r.reservation_id)).kind, 'polish');
    assert.equal((await Q('select count(*)::int n from result_recovery where reservation_id=$1', [r.reservation_id]))[0].n, 1);
    const again = await commitWith(r.reservation_id); assert.equal(again.outcome, 'already_committed'); assert.equal(again.included, true); assert.equal(await remaining(c), 4);
    assert.equal((await status(c)).included_available, 0);
    const next = await reserve(c, true); assert.equal(next.included_from, null, 'the next Polish is an ordinary paid one'); await commitWith(next.reservation_id); assert.equal(await remaining(c), 3);
  });

  await t.test('ZERO GENERATIONS: the included polish still works, then the code is closed to AI; no other path reaches the AI', async () => {
    const c = await seed(1); const a = await analyze(c); assert.equal(await remaining(c), 0);
    assert.equal((await reserve(c, false)).outcome, 'exhausted', 'a normal step is refused at zero');
    const s = await status(c); assert.equal(s.access_state, 'active'); assert.equal(s.included_available, 1);
    const r = await reserve(c, true); assert.equal(r.outcome, 'reserved'); assert.equal(r.included_from, a);
    const k = await commitWith(r.reservation_id); assert.equal(k.outcome, 'committed'); assert.equal(await remaining(c), 0);
    assert.equal((await reserve(c, true)).outcome, 'exhausted', 'no credit left and no generation: refused, even when it asks');
    assert.equal((await status(c)).access_state, 'completion');
  });

  await t.test('FAILURES AND INSIGNIFICANT RESULTS leave the credit untouched (release, and a lapsed lease)', async () => {
    const c = await seed(); const a = await analyze(c);
    const r1 = await reserve(c, true); await Q('select release_license_use($1,false)', [r1.reservation_id]);       // unchanged / insignificant / provider outage
    assert.equal((await row(a)).included_polish_by, null); assert.equal(await remaining(c), 4);
    const r2 = await reserve(c, true); assert.equal(r2.included_from, a);
    await Q(`update license_reservations set expires_at = now() - interval '1 minute' where id=$1`, [r2.reservation_id]);   // the worker died
    const r3 = await reserve(c, true); assert.equal(r3.included_from, a, 'a lapsed lease frees the credit again');
    const k = await commitWith(r3.reservation_id); assert.equal(k.outcome, 'committed'); assert.equal(await remaining(c), 4);
    const late = await commitWith(r2.reservation_id); assert.equal(late.outcome, 'included_gone', 'the stale attempt cannot take it a second time'); assert.equal(await remaining(c), 4);
    assert.equal((await Q('select count(*)::int n from result_recovery where reservation_id=$1', [r2.reservation_id]))[0].n, 0, 'and writes nothing');
  });

  await t.test('THE FAILURE BUDGET STILL APPLIES: an included polish cannot be used to hammer the AI after repeated costly failures', async () => {
    const c = await seed(); const a = await analyze(c);
    for (let i = 0; i < 6; i++) { const r = await reserve(c, true); assert.equal(r.outcome, 'reserved'); await Q('select release_license_use($1,true)', [r.reservation_id]); }   // six costly (counted) failures
    const blocked = await reserve(c, true); assert.equal(blocked.outcome, 'throttled'); assert.ok(blocked.retry_after_seconds > 0);
    assert.equal((await row(a)).included_polish_by, null, 'and the credit is still there when the throttle lifts'); assert.equal(await remaining(c), 4);
  });

  await t.test('SIMULTANEOUS: two live steps never hold the same credit, and two commits that both try produce exactly one winner', async () => {
    const c = await seed(); const a = await analyze(c);
    const first = await reserve(c, true); assert.equal(first.included_from, a);
    const second = await reserve(c, true); assert.equal(second.included_from, null, 'the second request is not given the held credit');
    await Q('select release_license_use($1,false)', [second.reservation_id]);
    // force the worst case: two live reservations pointing at the same credit (as if a stale one slipped through)
    const other = await reserve(c, false); await Q('update license_reservations set included_from=$2 where id=$1', [other.reservation_id, a]);
    const [x, y] = await Promise.all([commitWith(first.reservation_id), commitWith(other.reservation_id)]);
    assert.deepEqual([x.outcome, y.outcome].sort(), ['committed', 'included_gone']);
    assert.equal(await remaining(c), 4); assert.equal((await Q('select count(*)::int n from license_reservations where included_polish_by is not null and code=$1', [c]))[0].n, 1);
    await assert.rejects(() => db.admin('update license_reservations set included_polish_by=$1 where id=$2', [first.reservation_id, other.reservation_id]), /unique|duplicate/i, 'the database itself refuses a second claim');
  });

  await t.test('REPEATS: the same request id returns the same paid step (replay) and never uses a second credit or a generation', async () => {
    const c = await seed(); const a = await analyze(c); const key = 'k-included-1', hash = 'h-1';
    const r = await reserve(c, true, key, hash); assert.equal(r.included_from, a); await commitWith(r.reservation_id);
    const rep = await reserve(c, true, key, hash); assert.equal(rep.outcome, 'replay'); assert.equal(rep.reservation_id, r.reservation_id); assert.equal(rep.included_from, a);
    await Q('select finish_redelivery($1,true)', [r.reservation_id]); assert.equal(await remaining(c), 4);
    assert.equal((await reserve(c, true, key, 'different')).outcome, 'key_conflict');
  });

  await t.test('SCOPE: a credit can only be claimed by the same code that earned it', async () => {
    const a = await seed(); const b = await seed(); const analyzeA = await analyze(a); await analyze(b);
    const rb = await reserve(b, false); await Q('update license_reservations set included_from=$2 where id=$1', [rb.reservation_id, analyzeA]);
    assert.equal((await commitWith(rb.reservation_id)).outcome, 'included_gone'); assert.equal((await row(analyzeA)).included_polish_by, null);
  });

  await t.test('only a Polish may use an included polish; a refused attempt changes nothing', async () => {
    const c = await seed(); const a = await analyze(c); const r = await reserve(c, true);
    await assert.rejects(() => commitWith(r.reservation_id, 'analyze'), /only a polish/);
    assert.equal((await row(r.reservation_id)).status, 'reserved'); assert.equal((await row(a)).included_polish_by, null); assert.equal(await remaining(c), 4);
  });

  await t.test('NEVER EXPIRES: an unused included polish from a year ago is still usable', async () => {
    const c = await seed(); const a = await analyze(c);
    await Q(`update license_reservations set created_at = now() - interval '400 days', committed_at = now() - interval '400 days' where id=$1`, [a]);
    const s = await status(c); assert.equal(s.included_available, 1); assert.equal(s.access_state, 'active');
    const r = await reserve(c, true); assert.equal(r.included_from, a); assert.equal((await commitWith(r.reservation_id)).outcome, 'committed');
  });

  await t.test('THE 96-HOUR COMPLETION PERIOD: starts at the last benefit used, grants no AI, ends on time, and a top-up restores normal access', async () => {
    assert.equal((await status('FG-NONE-NONE')).access_state, 'not_found');
    const c = await seed(1); const a = await analyze(c); const r = await reserve(c, true); await commitWith(r.reservation_id);
    const s = await status(c); assert.equal(s.access_state, 'completion'); assert.equal(s.uses_remaining, 0); assert.equal(s.included_available, 0);
    const hours = (Date.parse(s.access_until) - Date.parse(s.last_benefit_at)) / 3600000; assert.equal(Math.round(hours), 96);
    assert.equal((await reserve(c, true)).outcome, 'exhausted', 'inside the period there is still no AI');
    await Q(`update license_reservations set committed_at = now() - interval '95 hours' where code=$1`, [c]); assert.equal((await status(c)).access_state, 'completion');
    await Q(`update license_reservations set committed_at = now() - interval '97 hours' where code=$1`, [c]); assert.equal((await status(c)).access_state, 'ended');
    assert.equal((await status(c, 200)).access_state, 'completion', 'the length is a parameter');
    await Q('update licenses set uses_remaining = 2 where code=$1', [c]); assert.equal((await status(c)).access_state, 'active');
    const legacy = await seed(0); assert.equal((await status(legacy)).access_state, 'ended', 'a code with no recorded benefit has no completion period');
    await Q(`update licenses set last_used_at = now() - interval '10 hours' where code=$1`, [legacy]); assert.equal((await status(legacy)).access_state, 'completion', 'older codes fall back to last_used_at');
  });

  await t.test('COMPATIBILITY: the calls the deployed builds make (5 named arguments; commit_license_use) work unchanged', async () => {
    const c = await seed();
    const r = (await Q('select * from reserve_license_use(p_code => $1, p_lease_seconds => 45, p_fail_window_seconds => 900, p_fail_window_max => 6, p_fail_day_max => 30)', [c]))[0];
    assert.equal(r.outcome, 'reserved'); assert.equal(r.included_from, null);
    const k = (await Q('select * from commit_license_use($1)', [r.reservation_id]))[0]; assert.equal(k.outcome, 'committed'); assert.equal(k.remaining, 4);
    const seven = (await Q('select * from reserve_license_use(p_code => $1, p_lease_seconds => 45, p_fail_window_seconds => 900, p_fail_window_max => 6, p_fail_day_max => 30, p_request_key => $2, p_input_hash => $3)', [c, 'compat-key', 'compat-hash']))[0];
    assert.equal(seven.outcome, 'reserved'); await commitWith(seven.reservation_id, 'analyze'); assert.equal(await remaining(c), 3);
  });

  await t.test('PRIVILEGES: the new and replaced functions are closed to browser roles', async () => {
    const fns = ['public.reserve_license_use(text,integer,integer,integer,integer,text,text,boolean)', 'public.commit_license_use_with_result(uuid,text,text,text,text,text,integer)', 'public.license_access_status(text,integer)'];
    for (const f of fns) { assert.equal(await H.canExecute(db, 'anon', f), false, f); assert.equal(await H.canExecute(db, 'authenticated', f), false, f); assert.equal(await H.canExecute(db, 'service_role', f), true, f); }
    const defs = (await db.admin(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public' and p.proname in ('reserve_license_use','commit_license_use_with_result','license_access_status') and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c='search_path=public')`)).rows[0].n;
    assert.equal(defs, 3);
    await assert.rejects(() => db.pool('anon', 2).query("select * from license_access_status('FG-AAAA-AAAA')"), /permission denied/i);
  });

  await t.test('ROLLBACK: restores the migration 03/04 functions, keeps every row and balance, and 05 can be applied again afterwards', async () => {
    const c = await seed(); const a = await analyze(c); const r = await reserve(c, true); await commitWith(r.reservation_id);
    const fp = await H.fingerprint(db); const rows = (await Q('select count(*)::int n from license_reservations'))[0].n;
    await db.admin(H.sqlFile('supabase', 'rollback', '20261027_05_rollback.sql'));
    assert.deepEqual(await H.fingerprint(db), fp); assert.equal((await Q('select count(*)::int n from license_reservations'))[0].n, rows);
    assert.equal((await row(a)).included_polish_by, r.reservation_id, 'the record of what was used survives');
    const sig = await Q(`select p.pronargs from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public' and p.proname='reserve_license_use'`);
    assert.deepEqual(sig.map((x) => x.pronargs), [7]);
    assert.equal((await Q(`select count(*)::int n from pg_proc where proname='license_access_status'`))[0].n, 0);
    const c2 = await seed(); const r2 = (await Q('select * from reserve_license_use($1,45,900,6,30,null,null)', [c2]))[0]; const k2 = await commitWith(r2.reservation_id, 'analyze'); assert.equal(k2.outcome, 'committed'); assert.equal(k2.remaining, 4); assert.equal('included' in k2, false, 'the old result shape is back');
    for (const f of ['public.reserve_license_use(text,integer,integer,integer,integer,text,text)', 'public.commit_license_use_with_result(uuid,text,text,text,text,text,integer)']) {
      assert.equal(await H.canExecute(db, 'anon', f), false); assert.equal(await H.canExecute(db, 'service_role', f), true);
    }
    await H.applyMigration(db, H.MIG5);
    assert.equal((await status(c2)).included_available, 0, 'a step committed while rolled back carries no credit (kind unknown)');
    assert.equal((await reserve(c, true)).included_from, null, 'the credit of the used polish stays used');
  });

  await svc.end(); await db.close();
});
