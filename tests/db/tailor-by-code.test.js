// Migration 06 at the SQL level (real local PostgreSQL, never Supabase): tailoring runs are found from the access code. Focused on the new path only:
// a code can use ONLY its own remaining runs, never more than 5 per qualifying paid step, never through an included Polish, with parallel requests
// serialised, refunds going back to the step that was used, and nothing else (balances, committed rows, existing functions) touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

test('tailoring by access code (migration 06): own runs only, 5 per paid step, atomic, additive (real SQL)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_m6'); await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db);
  for (const m of [H.MIG1, H.MIG2, H.MIG3, H.MIG4, H.MIG5]) await H.applyMigration(db, m);
  const before = await H.fingerprint(db);
  await H.applyMigration(db, H.MIG6);
  const svc = db.pool('service_role', 30); const Q = async (sql, p) => (await svc.query(sql, p)).rows;
  let n = 0; const seed = async (uses = 5) => { const c = `FG-M${String(++n).padStart(3, '0')}-MMMM`; await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const reserve = async (c, allow = false) => (await Q('select * from reserve_license_use($1,45,900,6,30,null,null,$2)', [c, allow]))[0];
  const commitWith = (id, fn) => svc.query('select * from commit_license_use_with_result($1,$2,$3,$4,$5,$6,$7)', [id, fn, '1', 'c2FsdA==', 'aXY=', 'Y2lwaGVydGV4dA==', 86400]).then((r) => r.rows[0]);
  const analyze = async (c) => { const r = await reserve(c); await commitWith(r.reservation_id, 'analyze'); return r.reservation_id; };
  const chargedPolish = async (c) => { const r = await reserve(c); await commitWith(r.reservation_id, 'polish'); return r.reservation_id; };
  const includedPolish = async (c) => { const r = await reserve(c, true); await commitWith(r.reservation_id, 'polish'); return r.reservation_id; };
  const use = async (c, max = 5) => (await Q('select * from consume_tailor_for_code($1,$2)', [c, max]))[0];
  const runs = async (c, max = 5) => (await Q('select * from tailor_runs_available($1,$2)', [c, max]))[0];
  const count = async (id) => (await Q('select tailor_count c from license_reservations where id=$1', [id]))[0].c;

  await t.test('additive: no balance or code changed, can be applied again, existing tailor functions untouched', async () => {
    assert.deepEqual(await H.fingerprint(db), before);
    await H.applyMigration(db, H.MIG6); await H.applyMigration(db, H.MIG6);
    assert.deepEqual(await H.fingerprint(db), before);
    for (const fn of ['consume_tailor_use', 'refund_tailor_use']) assert.equal((await Q(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public' and p.proname=$1`, [fn]))[0].n, 1);
  });

  await t.test('a code uses ONLY its own runs: another code can neither use nor see them', async () => {
    const a = await seed(), b = await seed(); const ra = await analyze(a); const rb = await analyze(b);
    assert.deepEqual(await use(a), { outcome: 'ok', reservation_id: ra, used: 1 });
    assert.equal(await count(rb), 0, 'the other code\'s step was not touched');
    assert.deepEqual(await runs(a), { runs_available: 4, paid_steps: 1 }); assert.deepEqual(await runs(b), { runs_available: 5, paid_steps: 1 });
    assert.equal((await use('FG-NONE-0000')).outcome, 'not_found'); assert.deepEqual(await runs('FG-NONE-0000'), { runs_available: 0, paid_steps: 0 });
    const lonely = await seed(); assert.equal((await use(lonely)).outcome, 'invalid', 'a code with no paid step has nothing to tailor with');
  });

  await t.test('five runs per qualifying step, never six; the sixth is refused and changes nothing', async () => {
    const c = await seed(); const a = await analyze(c);
    for (let i = 1; i <= 5; i++) assert.deepEqual(await use(c), { outcome: 'ok', reservation_id: a, used: i });
    assert.deepEqual(await use(c), { outcome: 'limit', reservation_id: null, used: null }); assert.equal(await count(a), 5);
    assert.deepEqual(await runs(c), { runs_available: 0, paid_steps: 1 });
  });

  await t.test('runs are per paid step and use the OLDEST step first; a charged Polish brings its own five, an included Polish brings none', async () => {
    const c = await seed(); const a = await analyze(c); const p = await chargedPolish(c); const inc = await includedPolish(c);
    assert.deepEqual(await runs(c), { runs_available: 10, paid_steps: 2 }, 'Analyze + charged Polish; the included Polish is not a step of its own');
    for (let i = 0; i < 5; i++) assert.equal((await use(c)).reservation_id, a);
    for (let i = 0; i < 5; i++) assert.equal((await use(c)).reservation_id, p);
    assert.equal((await use(c)).outcome, 'limit'); assert.equal(await count(inc), 0, 'the included Polish never gets runs of its own');
  });

  await t.test('only COMMITTED, non-included steps count: reserved, released and expired reservations add none', async () => {
    const c = await seed(); const a = await analyze(c);
    const open = await reserve(c); const rel = await reserve(c); await Q('select release_license_use($1,false)', [rel.reservation_id]);
    assert.deepEqual(await runs(c), { runs_available: 5, paid_steps: 1 });
    await Q(`update license_reservations set status='expired' where id=$1`, [open.reservation_id]);
    assert.deepEqual(await runs(c), { runs_available: 5, paid_steps: 1 });
    const old = await seed(); const r = await reserve(old); await Q('select * from commit_license_use($1)', [r.reservation_id]);        // committed before migration 05: no kind
    assert.deepEqual(await use(old), { outcome: 'ok', reservation_id: r.reservation_id, used: 1 }, 'an older committed step keeps its tailoring');
    assert.equal(await count(a), 0);
  });

  await t.test('runs survive time: nothing about them expires, and old and new steps are used in order', async () => {
    const c = await seed(); const a = await analyze(c); await use(c);
    await Q(`update license_reservations set committed_at = now() - interval '40 days', created_at = now() - interval '40 days' where id=$1`, [a]);
    assert.deepEqual(await runs(c), { runs_available: 4, paid_steps: 1 });
    assert.equal((await use(c)).used, 2);
  });

  await t.test('PARALLEL: 30 simultaneous requests on a code with 7 runs left => exactly 7 succeed, 23 refused, never more than 5 on one step', async () => {
    const c = await seed(); const a = await analyze(c); const p = await chargedPolish(c); await Q('update license_reservations set tailor_count = 3 where id=$1', [p]);
    const rs = await Promise.all(Array.from({ length: 30 }, () => use(c)));
    assert.equal(rs.filter((r) => r.outcome === 'ok').length, 7); assert.equal(rs.filter((r) => r.outcome === 'limit').length, 23);
    assert.equal(await count(a), 5); assert.equal(await count(p), 5);
  });

  await t.test('a refund goes back to the step that was used, with the existing refund rules (outage unlimited, other failures forgiven twice)', async () => {
    const c = await seed(); const a = await analyze(c); const p = await chargedPolish(c);
    const g = await use(c); assert.equal(g.reservation_id, a);
    await Q('select refund_tailor_use($1,true,2)', [g.reservation_id]); assert.equal(await count(a), 0, 'a provider outage is always given back');
    for (let i = 0; i < 3; i++) { const x = await use(c); await Q('select refund_tailor_use($1,false,2)', [x.reservation_id]); }
    assert.equal(await count(a), 1, 'the third non-outage failure stays used (two forgiven per step)'); assert.equal(await count(p), 0);
  });

  await t.test('tailoring never touches the 5-generation system: balances, statuses and the included-Polish credit are unchanged', async () => {
    const c = await seed(); await analyze(c); const bal = (await Q('select uses_remaining u from licenses where code=$1', [c]))[0].u; const st = await Q('select * from license_access_status($1)', [c]);
    for (let i = 0; i < 5; i++) await use(c);
    assert.equal((await Q('select uses_remaining u from licenses where code=$1', [c]))[0].u, bal);
    assert.deepEqual(await Q('select * from license_access_status($1)', [c]), st);
    assert.equal((await Q(`select count(*)::int n from license_reservations where code=$1 and status='committed'`, [c]))[0].n, 1);
  });

  await t.test('server-only: anon and authenticated cannot call either function; service_role can', async () => {
    for (const sig of ['consume_tailor_for_code(text,integer)', 'tailor_runs_available(text,integer)']) {
      assert.equal(await H.canExecute(db, 'anon', sig), false); assert.equal(await H.canExecute(db, 'authenticated', sig), false); assert.equal(await H.canExecute(db, 'service_role', sig), true);
    }
  });

  await t.test('rollback: dropping the two functions leaves everything else working, and the token path functions still answer', async () => {
    const c = await seed(); const a = await analyze(c);
    await db.admin('drop function consume_tailor_for_code(text, integer); drop function tailor_runs_available(text, integer);');
    assert.equal((await Q('select * from consume_tailor_use($1,5)', [a]))[0].outcome, 'ok');
    await H.applyMigration(db, H.MIG6);
  });

  await t.test('safe order: migration 06 refuses to run without migration 05 and changes nothing', async () => {
    const bare = await H.freshDatabase('rg_m6_bare'); await bare.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(bare);
    for (const m of [H.MIG1, H.MIG2, H.MIG3, H.MIG4]) await H.applyMigration(bare, m);
    await assert.rejects(() => bare.admin(H.sqlFile('supabase', 'migrations', H.MIG6)), /needs migrations 03 to 05/);
    assert.equal((await bare.admin(`select count(*)::int n from pg_proc where proname='consume_tailor_for_code'`)).rows[0].n, 0);
    await bare.close();
  });

  t.after(async () => { await db.close(); });
});
