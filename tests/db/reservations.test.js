const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const FN = {
  reserve: 'public.reserve_license_use(text,integer)', commit: 'public.commit_license_use(uuid)',
  release: 'public.release_license_use(uuid)', tailor: 'public.consume_tailor_use(uuid,integer)',
  refund: 'public.refund_tailor_use(uuid)', legacy: 'public.consume_license_use(text)',
};
const CODES = Array.from({ length: 12 }, (_, i) => `FG-TEST-${String(i).padStart(4, '0')}`);

test('DB-backed regression tests', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }

  // ---- production-shaped database: live snapshot -> migration 01 -> migration 02 ----
  const live = await H.freshDatabase('rg_live');
  await H.liveState(live);
  await H.seed(live, [
    { code: 'FG-CUST-0001', uses: 3, assigned: true, buyer: 'customer@example.com' },   // an existing customer mid-way
    { code: 'FG-PERS-0001', uses: 5, assigned: true },                                  // personal test code
    ...CODES.map(c => ({ code: c })),
  ]);
  const before = await H.fingerprint(live);

  await t.test('PRE: production starting state — consume_license_use is executable by anon (F-11)', async () => {
    assert.equal(await H.canExecute(live, 'anon', FN.legacy), true);
    assert.equal(await H.canExecute(live, 'authenticated', FN.legacy), true);
  });

  await t.test('migration 01 applies to the live state, is idempotent, and does not touch license rows', async () => {
    await live.admin(H.SUPABASE_DEFAULT_PRIVS);
    await H.applyMigration(live, H.MIG1);
    await H.applyMigration(live, H.MIG1);              // idempotent
    assert.deepEqual(await H.fingerprint(live), before);
  });

  await t.test('migration 02 (F-11) revokes public execute, keeps service_role, does not touch license rows', async () => {
    await H.applyMigration(live, H.MIG2);
    assert.equal(await H.canExecute(live, 'anon', FN.legacy), false);
    assert.equal(await H.canExecute(live, 'authenticated', FN.legacy), false);
    assert.equal(await H.canExecute(live, 'service_role', FN.legacy), true);
    assert.deepEqual(await H.fingerprint(live), before);
  });

  await t.test('every new function is server-only; the reservation table is closed to anon/authenticated', async () => {
    for (const f of Object.values(FN)) {
      assert.equal(await H.canExecute(live, 'anon', f), false, `anon must not run ${f}`);
      assert.equal(await H.canExecute(live, 'authenticated', f), false, `authenticated must not run ${f}`);
      assert.equal(await H.canExecute(live, 'service_role', f), true, `service_role must run ${f}`);
    }
    const r = await live.admin(`select has_table_privilege('anon','license_reservations','select') a, has_table_privilege('authenticated','license_reservations','select') b, has_table_privilege('service_role','license_reservations','select,insert,update,delete') c, (select relrowsecurity from pg_class where relname='license_reservations') rls`);
    assert.deepEqual(r.rows[0], { a: false, b: false, c: true, rls: true });
  });

  const svc = live.pool('service_role');
  const q = (sql, p) => svc.query(sql, p);
  const reserve = async (code, lease = 45) => (await q('select * from public.reserve_license_use($1,$2)', [code, lease])).rows[0];
  const commit = async (id) => (await q('select * from public.commit_license_use($1)', [id])).rows[0];
  const release = async (id) => (await q('select public.release_license_use($1) as s', [id])).rows[0].s;
  const remaining = async (code) => (await q('select uses_remaining from licenses where code=$1', [code])).rows[0].uses_remaining;

  await t.test('five paid generations, then exhausted (serial)', async () => {
    const c = CODES[0];
    for (let i = 1; i <= 5; i++) {
      const r = await reserve(c); assert.equal(r.outcome, 'reserved');
      const k = await commit(r.reservation_id); assert.equal(k.outcome, 'committed'); assert.equal(k.remaining, 5 - i);
    }
    assert.equal((await reserve(c)).outcome, 'exhausted');
    assert.equal(await remaining(c), 0);
  });

  await t.test('20 simultaneous requests on a 5-use code: exactly 5 reservations, the rest busy', async () => {
    const c = CODES[1];
    const rs = await Promise.all(Array.from({ length: 20 }, () => reserve(c)));
    assert.equal(rs.filter(r => r.outcome === 'reserved').length, 5);
    assert.equal(rs.filter(r => r.outcome === 'busy').length, 15);
    const ks = await Promise.all(rs.filter(r => r.outcome === 'reserved').map(r => commit(r.reservation_id)));
    assert.ok(ks.every(k => k.outcome === 'committed'));
    assert.equal(await remaining(c), 0);
    assert.equal((await reserve(c)).outcome, 'exhausted');
  });

  await t.test('10 simultaneous requests with ONE use left: exactly one reservation', async () => {
    const c = CODES[2]; await q('update licenses set uses_remaining=1 where code=$1', [c]);
    const rs = await Promise.all(Array.from({ length: 10 }, () => reserve(c)));
    assert.equal(rs.filter(r => r.outcome === 'reserved').length, 1);
    assert.equal(rs.filter(r => r.outcome === 'busy').length, 9);
  });

  await t.test('a failed attempt is released: capacity returns and no use is consumed', async () => {
    const c = CODES[3]; await q('update licenses set uses_remaining=1 where code=$1', [c]);
    const a = await reserve(c); assert.equal(a.outcome, 'reserved');
    assert.equal((await reserve(c)).outcome, 'busy');
    assert.equal(await release(a.reservation_id), 'released');
    assert.equal(await release(a.reservation_id), 'released');           // idempotent
    assert.equal(await remaining(c), 1);
    assert.equal((await reserve(c)).outcome, 'reserved');
  });

  await t.test('crash / timeout: an abandoned reservation expires by itself and never costs a use', async () => {
    const c = CODES[4]; await q('update licenses set uses_remaining=1 where code=$1', [c]);
    const dead = await reserve(c);                                         // process "crashes" here: nothing releases it
    assert.equal((await reserve(c)).outcome, 'busy');                      // still within its lease
    await live.admin(`update license_reservations set expires_at = now() - interval '1 second' where id=$1`, [dead.reservation_id]);
    assert.equal(await remaining(c), 1);                                   // unchanged
    const next = await reserve(c);
    assert.equal(next.outcome, 'reserved');
    // the zombie wakes up and tries to commit late: slot is taken by `next`, so it must NOT double-spend
    const late = await commit(dead.reservation_id);
    assert.equal(late.outcome, 'expired');
    assert.equal(await remaining(c), 1);
    assert.equal((await commit(next.reservation_id)).outcome, 'committed');
    assert.equal(await remaining(c), 0);
  });

  await t.test('late commit still succeeds when no one else needed the slot', async () => {
    const c = CODES[5];
    const a = await reserve(c);
    await live.admin(`update license_reservations set expires_at = now() - interval '1 second' where id=$1`, [a.reservation_id]);
    assert.equal((await commit(a.reservation_id)).outcome, 'committed');
    assert.equal(await remaining(c), 4);
  });

  await t.test('commit is idempotent, including 10 simultaneous commits of the same reservation', async () => {
    const c = CODES[6]; const a = await reserve(c);
    const ks = await Promise.all(Array.from({ length: 10 }, () => commit(a.reservation_id)));
    assert.equal(ks.filter(k => k.outcome === 'committed').length, 1);
    assert.equal(ks.filter(k => k.outcome === 'already_committed').length, 9);
    assert.equal(await remaining(c), 4);                                   // decremented exactly once
    assert.equal(await release(a.reservation_id), 'committed');           // releasing a paid op is a no-op
    assert.equal(await remaining(c), 4);
  });

  await t.test('a released reservation can never be committed afterwards', async () => {
    const c = CODES[7]; const a = await reserve(c); await release(a.reservation_id);
    assert.equal((await commit(a.reservation_id)).outcome, 'released');
    assert.equal(await remaining(c), 5);
  });

  await t.test('unknown code / unknown reservation', async () => {
    assert.equal((await reserve('FG-NOPE-0000')).outcome, 'not_found');
    const ghost = '00000000-0000-0000-0000-000000000000';
    assert.equal((await commit(ghost)).outcome, 'not_found');
    assert.equal(await release(ghost), 'not_found');
  });

  await t.test('tailoring authorisation: needs a committed op; capped at 5 even under 20 parallel replays; refund is bounded', async () => {
    const c = CODES[8]; const a = await reserve(c);
    const tl = async (id, max = 5) => (await q('select * from public.consume_tailor_use($1,$2)', [id, max])).rows[0];
    assert.equal((await tl(a.reservation_id)).outcome, 'invalid');         // not paid yet
    await commit(a.reservation_id);
    const rs = await Promise.all(Array.from({ length: 20 }, () => tl(a.reservation_id)));
    assert.equal(rs.filter(r => r.outcome === 'ok').length, 5);
    assert.equal(rs.filter(r => r.outcome === 'limit').length, 15);
    for (let i = 0; i < 8; i++) await q('select public.refund_tailor_use($1)', [a.reservation_id]);
    assert.equal((await q('select tailor_count from license_reservations where id=$1', [a.reservation_id])).rows[0].tailor_count, 0);
    assert.equal((await tl('00000000-0000-0000-0000-000000000000')).outcome, 'not_found');
  });

  await t.test('commit sets last_used_at and never drives uses below zero', async () => {
    const c = CODES[9]; await q('update licenses set uses_remaining=1 where code=$1', [c]);
    const a = await reserve(c); await commit(a.reservation_id);
    const row = (await q('select uses_remaining, last_used_at from licenses where code=$1', [c])).rows[0];
    assert.equal(row.uses_remaining, 0); assert.ok(row.last_used_at);
  });

  await t.test('housekeeping drops dead reservations older than 30 days only', async () => {
    const c = CODES[10]; const a = await reserve(c); await release(a.reservation_id);
    await live.admin(`update license_reservations set created_at = now() - interval '31 days' where id=$1`, [a.reservation_id]);
    await reserve(c);
    assert.equal((await q('select count(*)::int n from license_reservations where id=$1', [a.reservation_id])).rows[0].n, 0);
  });

  await t.test('existing customers are untouched: customer mid-way keeps 3 uses and can still finish them', async () => {
    const c = 'FG-CUST-0001';
    assert.equal(await remaining(c), 3);
    for (let i = 0; i < 3; i++) { const r = await reserve(c); assert.equal(r.outcome, 'reserved'); await commit(r.reservation_id); }
    assert.equal(await remaining(c), 0);
    assert.equal((await q('select buyer_email, assigned from licenses where code=$1', [c])).rows[0].buyer_email, 'customer@example.com');
  });

  await t.test('Google Apps Script replay under service_role still works after hardening (select unassigned, then PATCH assigned/buyer_email)', async () => {
    const pick = await q(`select code from licenses where assigned = false order by created_at asc limit 1`);
    assert.equal(pick.rows.length, 1);
    const upd = await q(`update licenses set assigned = true, assigned_at = now(), buyer_email = $2 where code = $1 and assigned = false`, [pick.rows[0].code, 'buyer@example.com']);
    assert.equal(upd.rowCount, 1);
  });

  await t.test('check-code-supply style access still works (count head + bulk insert of unassigned codes)', async () => {
    const cnt = await q(`select count(code)::int n from licenses where assigned = false`);
    assert.ok(cnt.rows[0].n >= 0);
    await q(`insert into licenses(code,max_uses,uses_remaining,assigned) values ('FG-NEW0-0001',5,5,false),('FG-NEW0-0002',5,5,false)`);
  });

  // ---- fresh install from schema.sql must equal the migrated production shape ----
  const fresh = await H.freshDatabase('rg_fresh');
  await fresh.admin(H.SUPABASE_DEFAULT_PRIVS);
  await fresh.admin(H.sqlFile('supabase', 'schema.sql'));

  await t.test('schema.sql re-run is idempotent and applies cleanly to a fresh database', async () => {
    await fresh.admin(H.sqlFile('supabase', 'schema.sql'));
  });

  await t.test('schema.sql (fresh) and migrations (live) end in the same function set and privilege matrix; no Zapier-era function', async () => {
    const matrix = async (db) => (await db.admin(`
      select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as fn,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authed,
             has_function_privilege('service_role', p.oid, 'execute') as svc,
             p.prosecdef as definer
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1`)).rows;
    const a = await matrix(live), b = await matrix(fresh);
    assert.deepEqual(b, a);
    assert.ok(!a.some(r => r.fn.startsWith('assign_next_license')));
    assert.ok(a.every(r => r.anon === false && r.authed === false && r.svc === true && r.definer === true));
    const cols = async (db, t2) => (await db.admin(`select column_name, data_type from information_schema.columns where table_schema='public' and table_name='${t2}' order by 1`)).rows;
    assert.deepEqual(await cols(fresh, 'licenses'), await cols(live, 'licenses'));
    assert.deepEqual(await cols(fresh, 'license_reservations'), await cols(live, 'license_reservations'));
  });

  await live.close(); await fresh.close();
});
