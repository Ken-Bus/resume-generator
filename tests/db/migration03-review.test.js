// Migration 03 review evidence (local disposable PostgreSQL only; nothing here can reach Supabase):
//   1. COMPATIBILITY: the calls the code in production makes today still behave identically before and after migration 03.
//        - the ORIGINAL production code (the commit before the reservation work: consume-generation, verify-license) is run for real;
//        - the post-migration-01 shape (5-argument reserve, commit, release, tailor, refund) is compared state by state;
//        - the Google Apps Script / check-code-supply table operations (select, update, insert on `licenses`).
//   2. PERMISSIONS: only service_role may run anything new; anon / authenticated may not; the table stays closed.
//   3. APPLICATION UNDER LOAD: migration 03 is applied while old-style traffic is running; nothing is lost, double charged or left held.
//   4. CRASH / RESTART: a reservation that never committed is never mistaken for a paid step.
//   5. ROLLBACK: supabase/rollback/20261023_03_rollback.sql restores the 5-argument function, keeps every customer balance and every
//      committed row, and migration 03 can be applied again afterwards (roll forward).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const H = require('./helpers');
const { loadHandlers, post, parseBody } = require('../functions/harness');

const ROOT = path.join(__dirname, '..', '..');
const ROLLBACK = fs.readFileSync(path.join(ROOT, 'supabase', 'rollback', '20261023_03_rollback.sql'), 'utf8');
const PRE_RESERVATION = 'd1abe1d^';                      // the last commit before server-side reservation accounting: what production runs today

function oldProductionHandlers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oldprod-'));
  for (const f of ['netlify/functions/_lib/supabase.js', 'netlify/functions/_lib/alert.js', 'netlify/functions/consume-generation.js', 'netlify/functions/verify-license.js']) {
    const out = path.join(dir, path.basename(path.dirname(f)) === '_lib' ? '_lib' : '', path.basename(f)); fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, execSync(`git show ${PRE_RESERVATION}:${f}`, { cwd: ROOT }));
  }
  return { consume: require(path.join(dir, 'consume-generation.js')).handler, verify: require(path.join(dir, 'verify-license.js')).handler };
}

test('migration 03 review: compatibility, permissions, load, restart, rollback (local PostgreSQL)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock' });

  // Four production-shaped databases: A = today's live snapshot, B = + migration 01, C = + 02, D = + 03.
  const states = {};
  for (const [name, migs] of [['A', []], ['B', [H.MIG1]], ['C', [H.MIG1, H.MIG2]], ['D', [H.MIG1, H.MIG2, H.MIG3]]]) {
    const db = await H.freshDatabase(`rg_m3_${name.toLowerCase()}`);
    await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db);
    await H.seed(db, [{ code: 'FG-OLD1-AAAA', uses: 3, assigned: true, buyer: 'customer@example.com' }, { code: 'FG-OLD2-AAAA', uses: 1, assigned: true }, { code: 'FG-OLD3-AAAA', uses: 5 }]);
    for (const m of migs) await H.applyMigration(db, m);
    states[name] = db;
  }

  await t.test('COMPATIBILITY 1: the ORIGINAL production code (verify-license, consume-generation) answers identically in all four database states', async () => {
    const answers = {};
    for (const [name, db] of Object.entries(states)) {
      const pool = db.pool('service_role', 5); loadHandlers(pool); const old = oldProductionHandlers();
      const say = async (h, body) => { const r = await h(post(body)); return { status: r.statusCode, body: parseBody(r) }; };
      answers[name] = [
        await say(old.verify, { code: 'FG-OLD1-AAAA' }), await say(old.verify, { code: 'FG-NONE-AAAA' }),
        await say(old.consume, { code: 'FG-OLD1-AAAA' }), await say(old.consume, { code: 'FG-OLD2-AAAA' }), await say(old.consume, { code: 'FG-OLD2-AAAA' }),   // second one is "all used"
        await say(old.consume, { code: 'FG-NONE-AAAA' }), await say(old.verify, { code: 'FG-OLD1-AAAA' }),
      ];
      await pool.end();
    }
    assert.equal(answers.A[2].body.success, true); assert.equal(answers.A[4].body.success, false);          // the scenario really exercised success and exhaustion
    for (const name of ['B', 'C', 'D']) assert.deepEqual(answers[name], answers.A, `state ${name} answers differently from today's database`);
  });

  await t.test('COMPATIBILITY 2: the post-migration-01 calls (5-argument reserve, commit, release, tailor, refund) give identical results in B and D', async () => {
    const runShape = async (db) => {
      const q = (sql, p) => db.pool('service_role', 1).query(sql, p).then((r) => r.rows);
      const svc = db.pool('service_role', 2); const Q = async (sql, p) => (await svc.query(sql, p)).rows;
      const out = [];
      const norm = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'reservation_id' ? (v ? 'id' : v) : v])));
      const r1 = (await Q('select * from public.reserve_license_use($1,$2,$3,$4,$5)', ['FG-OLD3-AAAA', 45, 900, 6, 30]))[0]; out.push(norm([r1]));
      out.push(norm(await Q('select * from public.commit_license_use($1)', [r1.reservation_id])));
      out.push(norm(await Q('select * from public.commit_license_use($1)', [r1.reservation_id])));                       // idempotent
      out.push(norm(await Q('select * from public.consume_tailor_use($1,$2)', [r1.reservation_id, 5])));
      out.push(await Q('select public.refund_tailor_use($1,false,2) as n', [r1.reservation_id]));
      const r2 = (await Q('select * from public.reserve_license_use($1)', ['FG-OLD3-AAAA']))[0]; out.push(norm([r2]));      // defaults still work
      out.push(await Q('select public.release_license_use($1,false) as s', [r2.reservation_id]));
      out.push(norm(await Q('select * from public.reserve_license_use($1)', ['FG-NONE-AAAA'])));
      out.push(await Q('select uses_remaining from licenses where code=$1', ['FG-OLD3-AAAA']));
      await svc.end(); return out;
    };
    const b = await runShape(states.B), d = await runShape(states.D);
    assert.deepEqual(d, b);
    assert.equal(b[0][0].outcome, 'reserved'); assert.equal(b[1][0].outcome, 'committed'); assert.equal(b[2][0].outcome, 'already_committed');
  });

  await t.test('COMPATIBILITY 3: the table operations of check-code-supply and the Google Apps Script still work (select, update, insert on licenses) and migration 03 touched no license row', async () => {
    const svc = states.D.pool('service_role', 2);
    const unassigned = (await svc.query('select count(*)::int n from licenses where assigned = false')).rows[0].n; assert.ok(unassigned >= 1);
    await svc.query("update licenses set assigned = true, assigned_at = now(), buyer_email = 'buyer@example.com' where code = 'FG-OLD3-AAAA'");   // the Apps Script's PATCH
    await svc.query("insert into licenses (code, max_uses, uses_remaining) values ('FG-NEW1-AAAA', 5, 5)");                                       // the supply top-up
    assert.equal((await svc.query("select uses_remaining u from licenses where code='FG-NEW1-AAAA'")).rows[0].u, 5);
    await svc.end();
    const fresh = await H.freshDatabase('rg_m3_fp'); await H.liveState(fresh); await H.seed(fresh, [{ code: 'FG-OLD1-AAAA', uses: 3, assigned: true, buyer: 'customer@example.com' }, { code: 'FG-OLD2-AAAA', uses: 1, assigned: true }, { code: 'FG-OLD3-AAAA', uses: 5 }]);
    const live = await H.fingerprint(fresh); for (const m of [H.MIG1, H.MIG2, H.MIG3]) await H.applyMigration(fresh, m);
    assert.deepEqual(await H.fingerprint(fresh), live, 'applying all three migrations changes no license row'); await fresh.close();
  });

  await t.test('PERMISSIONS: every function is server-only; anon/authenticated cannot run or read anything new; the reservation table stays closed', async () => {
    const fns = (await states.D.admin(`select p.oid::regprocedure::text fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1`)).rows.map((r) => r.fn);
    assert.ok(fns.some((f) => f.startsWith('purge_idempotency_hashes')) && fns.some((f) => f.startsWith('finish_redelivery')) && fns.some((f) => f.includes('reserve_license_use(text,integer,integer,integer,integer,text,text)')));
    for (const f of fns) {
      assert.equal(await H.canExecute(states.D, 'anon', f), false, `anon can run ${f}`); assert.equal(await H.canExecute(states.D, 'authenticated', f), false, `authenticated can run ${f}`);
      assert.equal(await H.canExecute(states.D, 'service_role', f), true, `service_role cannot run ${f}`);
    }
    const r = (await states.D.admin(`select has_table_privilege('anon','license_reservations','select,insert,update,delete') a, has_table_privilege('authenticated','license_reservations','select,insert,update,delete') b, (select relrowsecurity from pg_class where relname='license_reservations') rls`)).rows[0];
    assert.deepEqual(r, { a: false, b: false, rls: true });
    const defs = (await states.D.admin(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('reserve_license_use','finish_redelivery') and p.prosecdef and 'search_path=public' = any(p.proconfig)`)).rows[0].n;
    assert.equal(defs, 2, 'both new-surface functions are security definer with a pinned search_path');
  });

  await t.test('APPLICATION UNDER LOAD: migration 03 applied while old-style traffic runs: no error, no lost or double charge, nothing left held', async () => {
    const db = await H.freshDatabase('rg_m3_load'); await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db);
    await H.seed(db, [{ code: 'FG-LOAD-AAAA', uses: 50, assigned: true }]); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2);
    const pools = Array.from({ length: 8 }, () => db.pool('service_role', 1)); let committed = 0; const errors = []; let stop = false;
    const worker = async (pool) => {
      while (!stop) {
        try {
          const r = (await pool.query('select * from public.reserve_license_use($1,$2,$3,$4,$5)', ['FG-LOAD-AAAA', 45, 900, 6, 30])).rows[0];
          if (r.outcome === 'reserved') { const c = (await pool.query('select * from public.commit_license_use($1)', [r.reservation_id])).rows[0]; if (c.outcome === 'committed') committed++; }
          else if (r.outcome === 'exhausted') return;
        } catch (e) { errors.push(e.message); }
      }
    };
    const running = pools.map(worker);
    await new Promise((r) => setTimeout(r, 30));
    await H.applyMigration(db, H.MIG3);                                                    // mid-traffic
    await H.applyMigration(db, H.MIG3);                                                    // and again: idempotent
    await new Promise((r) => setTimeout(r, 400)); stop = true; await Promise.all(running);
    const left = (await db.admin("select uses_remaining u from licenses where code='FG-LOAD-AAAA'")).rows[0].u;
    assert.deepEqual(errors, [], 'no request failed while the migration ran');
    assert.equal(50 - left, committed, 'every committed step cost exactly one generation, none was lost or doubled');
    assert.equal((await db.admin("select count(*)::int n from license_reservations where code='FG-LOAD-AAAA' and status='reserved' and expires_at > now()")).rows[0].n, 0, 'nothing is left held');
    await Promise.all(pools.map((p) => p.end())); await db.close();
  });

  await t.test('CRASH / RESTART: a keyed reservation that never committed (worker died) is not a paid step; once its lease lapses the same key is a new reservation', async () => {
    const svc = states.D.pool('service_role', 2); const Q = async (sql, p) => (await svc.query(sql, p)).rows;
    await H.seed(states.D, [{ code: 'FG-CRSH-AAAA', uses: 5, assigned: true }]);
    const a = (await Q('select * from public.reserve_license_use($1,5,900,6,30,$2,$3)', ['FG-CRSH-AAAA', 'k-crash', 'in-crash']))[0]; assert.equal(a.outcome, 'reserved');
    assert.equal((await Q('select * from public.reserve_license_use($1,5,900,6,30,$2,$3)', ['FG-CRSH-AAAA', 'k-crash', 'in-crash']))[0].outcome, 'replay_busy', 'a live but uncommitted reservation is never replayed as paid: it is an overlapping duplicate');
    assert.equal((await Q('select * from public.reserve_license_use($1,5,900,6,30,$2,$3)', ['FG-CRSH-AAAA', 'k-crash', 'in-other']))[0].outcome, 'key_conflict', 'and the same id with other input is refused');
    await states.D.admin("update license_reservations set expires_at = now() - interval '1 second' where code='FG-CRSH-AAAA'");
    const again = (await Q('select * from public.reserve_license_use($1,5,900,6,30,$2,$3)', ['FG-CRSH-AAAA', 'k-crash', 'in-crash']))[0]; assert.equal(again.outcome, 'reserved');
    assert.equal((await Q("select uses_remaining u from licenses where code='FG-CRSH-AAAA'"))[0].u, 5, 'nothing was charged by any of that');
    await Q('select * from public.commit_license_use($1)', [again.reservation_id]);
    assert.equal((await Q('select * from public.reserve_license_use($1,5,900,6,30,$2,$3)', ['FG-CRSH-AAAA', 'k-crash', 'in-crash']))[0].outcome, 'replay', 'after the commit the same key is a replay');
    assert.equal((await Q("select uses_remaining u from licenses where code='FG-CRSH-AAAA'"))[0].u, 4);
    await svc.end();
  });

  await t.test('RUNBOOK: the preflight file is strictly read-only, identifies every database state correctly, and the no-AI duplicate-charge smoke test from the runbook behaves as documented', async () => {
    const pre = fs.readFileSync(path.join(ROOT, 'docs', 'MIGRATION_03_PREFLIGHT.sql'), 'utf8');
    const code = pre.replace(/--.*$/gm, '');
    assert.equal(/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|notify|vacuum|copy)\b/i.test(code.replace(/'[^']*'/g, "''")), false, 'only select statements (string literals aside)');
    const stmts = code.split(';').map((x) => x.trim()).filter(Boolean);
    const run = async (db) => { const out = []; for (const stmt of stmts) out.push((await db.admin(stmt)).rows); return out; };
    const stateOf = async (db) => (await db.admin(stmts[0])).rows[0].database_state;       // state A has no reservation table, so later statements may legitimately error there
    assert.match(await stateOf(states.A), /^A: /); assert.match(await stateOf(states.B), /^B\/C/); assert.match(await stateOf(states.C), /^B\/C/); assert.match(await stateOf(states.D), /^D: /);
    const rb = await H.freshDatabase('rg_m3_pf'); await rb.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(rb); for (const m of [H.MIG1, H.MIG2, H.MIG3]) await H.applyMigration(rb, m); await rb.admin(ROLLBACK);
    assert.match(await stateOf(rb), /^R: /); await rb.close();
    const d = await run(states.D);                                                       // after-migration expectations of the runbook (step 7)
    assert.deepEqual(d[1].filter((r) => r.proname === 'reserve_license_use').map((r) => r.args), [7]); assert.equal(d[2].length, 5);
    assert.ok(d[3].every((r) => r.anon === false && r.authenticated === false && r.service_role === true)); assert.deepEqual(d[4][0], { anon_table: false, authenticated_table: false, rls_on: true });
    // runbook step 10: the throwaway-license smoke test, in the documented order
    const svc = states.D.pool('service_role', 2); const Q = async (sql, p) => (await svc.query(sql, p)).rows;
    await Q("insert into licenses (code, max_uses, uses_remaining, assigned) values ('FG-SMKE-TEST', 5, 5, true)");
    const r1 = (await Q("select * from reserve_license_use('FG-SMKE-TEST',45,900,6,30,'smoke-key','smoke-input')"))[0]; assert.equal(r1.outcome, 'reserved');
    assert.equal((await Q('select * from commit_license_use($1)', [r1.reservation_id]))[0].remaining, 4);
    const r2 = (await Q("select * from reserve_license_use('FG-SMKE-TEST',45,900,6,30,'smoke-key','smoke-input')"))[0]; assert.equal(r2.outcome, 'replay'); assert.equal(r2.remaining, 4);
    await Q('select finish_redelivery($1, true)', [r1.reservation_id]);
    assert.equal((await Q("select * from reserve_license_use('FG-SMKE-TEST',45,900,6,30,'smoke-key','other-input')"))[0].outcome, 'key_conflict');
    await Q("delete from licenses where code = 'FG-SMKE-TEST'"); assert.equal((await Q("select count(*)::int n from license_reservations where code = 'FG-SMKE-TEST'"))[0].n, 0, 'cleanup removes the throwaway rows');
    await svc.end();
  });

  await t.test('ROLLBACK: the rollback script restores the 5-argument function, keeps every balance and committed row, and migration 03 can be applied again', async () => {
    const db = await H.freshDatabase('rg_m3_rb'); await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db);
    await H.seed(db, [{ code: 'FG-RB01-AAAA', uses: 5, assigned: true }, { code: 'FG-RB02-AAAA', uses: 3, assigned: true }]);
    for (const m of [H.MIG1, H.MIG2, H.MIG3]) await H.applyMigration(db, m);
    const svc = db.pool('service_role', 3); const Q = async (sql, p) => (await svc.query(sql, p)).rows;
    const k = (await Q('select * from public.reserve_license_use($1,45,900,6,30,$2,$3)', ['FG-RB01-AAAA', 'k-rb', 'in-rb']))[0]; await Q('select * from public.commit_license_use($1)', [k.reservation_id]);
    const plain = (await Q('select * from public.reserve_license_use($1)', ['FG-RB02-AAAA']))[0]; await Q('select * from public.commit_license_use($1)', [plain.reservation_id]);
    const snapshot = async () => ({ lic: (await Q('select code, uses_remaining, max_uses from licenses order by code')), rsv: (await Q("select id, code, status from license_reservations where status='committed' order by id")) });
    const pre = await snapshot();

    await db.admin(ROLLBACK);
    await db.admin(ROLLBACK);                                                              // idempotent
    assert.deepEqual(await snapshot(), pre, 'rollback changes no balance and no committed reservation');
    assert.deepEqual((await db.admin("select proname, pronargs from pg_proc where proname in ('reserve_license_use','finish_redelivery','purge_idempotency_hashes') order by 1")).rows, [{ proname: 'reserve_license_use', pronargs: 5 }]);
    const old = (await Q('select * from public.reserve_license_use($1,$2,$3,$4,$5)', ['FG-RB01-AAAA', 45, 900, 6, 30]))[0]; assert.equal(old.outcome, 'reserved');   // the previous deployment's call works
    await Q('select public.release_license_use($1,false)', [old.reservation_id]);
    await assert.rejects(() => Q('select * from public.reserve_license_use($1,45,900,6,30,$2,$3)', ['FG-RB01-AAAA', 'k-rb', 'in-rb']), /does not exist/, 'the new-code call fails closed (the new build answers "try again" and never charges)');
    for (const f of ['public.reserve_license_use(text,integer,integer,integer,integer)', 'public.commit_license_use(uuid)']) {
      assert.equal(await H.canExecute(db, 'anon', f), false); assert.equal(await H.canExecute(db, 'service_role', f), true);
    }

    await H.applyMigration(db, H.MIG3);                                                    // roll forward again
    assert.equal((await Q('select * from public.reserve_license_use($1,45,900,6,30,$2,$3)', ['FG-RB01-AAAA', 'k-rb', 'in-rb']))[0].outcome, 'replay', 'the key written before the rollback is still honoured after rolling forward');
    assert.deepEqual((await db.admin("select proname, pronargs from pg_proc where proname in ('reserve_license_use','finish_redelivery','purge_idempotency_hashes') order by 1")).rows, [{ proname: 'finish_redelivery', pronargs: 2 }, { proname: 'purge_idempotency_hashes', pronargs: 0 }, { proname: 'reserve_license_use', pronargs: 7 }]);
    await svc.end(); await db.close();
  });

  for (const db of Object.values(states)) await db.close();
});
