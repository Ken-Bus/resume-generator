// Shared helpers for tests that need a real Postgres.
// They talk to a DISPOSABLE local server (never Supabase). Start one with the commands in tests/README.md.
// If no server is reachable the DB-backed tests are skipped, not failed.
const fs = require('fs');
const path = require('path');
const { Pool, Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const HOST = process.env.TEST_PG_HOST || '/home/user/pgtest';
const PORT = parseInt(process.env.TEST_PG_PORT || '5544', 10);
const ADMIN = { host: HOST, port: PORT, user: process.env.TEST_PG_USER || 'postgres', database: 'postgres' };

const sqlFile = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

async function available() {
  const c = new Client(ADMIN);
  try { await c.connect(); await c.end(); return true; } catch (e) { return false; }
}

// Roles mimic Supabase. Created once per cluster; harmless if they already exist.
async function ensureRoles(admin) {
  for (const [r, extra] of [['anon', ''], ['authenticated', ''], ['service_role', 'bypassrls']]) {
    await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname='${r}') then create role ${r} nologin ${extra}; end if; end $$;`);
  }
}

async function freshDatabase(name) {
  const admin = new Client(ADMIN);
  await admin.connect();
  await ensureRoles(admin);
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const db = { name, pools: [] };
  db.admin = async (sql, params) => { const c = new Client({ ...ADMIN, database: name }); await c.connect(); try { return await c.query(sql, params); } finally { await c.end(); } };
  // A pool whose sessions run as service_role (what Netlify and the Apps Script use), so grants are really exercised.
  db.pool = (role = 'service_role', max = 25) => {
    const p = new Pool({ ...ADMIN, database: name, max, options: role ? `-c role=${role}` : undefined });
    p.on('error', () => {});                     // an idle client being closed during teardown is expected, not a failure
    db.pools.push(p); return p;
  };
  db.close = async () => { await Promise.all(db.pools.map(p => p.end().catch(() => {}))); await new Promise(r => setTimeout(r, 200)); await (async () => { const a = new Client(ADMIN); await a.connect(); await a.query(`drop database if exists ${name} with (force)`); await a.end(); })(); };
  return db;
}

// Supabase gives new public-schema functions EXECUTE for anon/authenticated by default; reproduce that so the revokes are really tested.
const SUPABASE_DEFAULT_PRIVS = `alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;`;

async function liveState(db) {            // production as of 2026-10-20
  await db.admin(sqlFile('tests', 'db', 'live_snapshot.sql'));
}
async function applyMigration(db, file) {
  await db.admin(sqlFile('supabase', 'migrations', file));
  // Regression mode: WITH_MIG5=1 applies migration 05 right after 04 in every existing suite, to prove the older behaviour is unchanged on top of it.
  if (file === '20261024_04_result_recovery.sql' && process.env.WITH_MIG5 === '1') {
    await db.admin(sqlFile('supabase', 'migrations', '20261027_05_included_polish.sql'));
    // Migration 06 (tailoring by access code) rides on 05. WITH_MIG6=0 keeps a suite on 05 only; compat-matrix applies every migration itself.
    if (process.env.WITH_MIG6 !== '0') await db.admin(sqlFile('supabase', 'migrations', '20261028_06_tailor_by_code.sql'));
  }
}
const MIG1 = '20261020_01_license_reservations.sql';
const MIG2 = '20261020_02_revoke_public_execute_consume_license_use.sql';
const MIG3 = '20261023_03_request_idempotency.sql';
const MIG4 = '20261024_04_result_recovery.sql';
const MIG5 = '20261027_05_included_polish.sql';
const MIG6 = '20261028_06_tailor_by_code.sql';

async function seed(db, rows) {            // rows: [{code, uses, max, assigned, buyer}]
  for (const r of rows) {
    await db.admin(`insert into licenses(code,max_uses,uses_remaining,assigned,buyer_email) values ($1,$2,$3,$4,$5)`,
      [r.code, r.max ?? 5, r.uses ?? 5, r.assigned ?? false, r.buyer ?? null]);
  }
}
async function fingerprint(db) {
  const r = await db.admin(`select count(*)::int as rows, coalesce(sum(uses_remaining),0)::int as remaining,
    coalesce(md5(string_agg(code||':'||max_uses||':'||uses_remaining||':'||assigned::text||':'||coalesce(buyer_email,''), ',' order by code)),'') as fp from licenses`);
  return r.rows[0];
}
async function canExecute(db, role, fnSignature) {
  const r = await db.admin(`select has_function_privilege($1, $2::regprocedure, 'execute') as ok`, [role, fnSignature]);
  return r.rows[0].ok;
}

module.exports = { available, freshDatabase, liveState, applyMigration, seed, fingerprint, canExecute, sqlFile, SUPABASE_DEFAULT_PRIVS, MIG1, MIG2, MIG3, MIG4, MIG5, MIG6, ADMIN };
