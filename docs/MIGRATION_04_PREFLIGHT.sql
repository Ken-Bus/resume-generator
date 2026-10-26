-- MIGRATION 04 PREFLIGHT: READ-ONLY. Contains only SELECT statements (no function that writes is called). Safe to run any time, any number of times,
-- in the Supabase SQL editor. Run it BEFORE migration 04 (expect state "D") and keep the output next to the post-check output.
-- Each numbered query states what to expect. STOP conditions are named in docs/MIGRATION_04_RELEASE_VERIFICATION.md section 5.

-- 1. Which database state is this?  A = no reservation table | B/C = 01(+02) only | D = +03 | E = +03 +04 | R4 = 03 present, 04 rolled back (same as D)
--    EXPECT BEFORE migration 04: "D: migration 03 applied, 04 not applied".
select
  case
    when not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'license_reservations')
      then 'A: no reservation table (apply 01, 02, 03 first)'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'reserve_license_use' and p.pronargs = 7)
      then 'B/C: migration 03 NOT applied (apply 03 before 04)'
    when exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'result_recovery')
         and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname in ('commit_license_use_with_result','list_recoverable_results','fetch_recoverable_result','purge_recoverable_results')) = 4
      then 'E: migration 04 already applied'
    when exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'result_recovery')
      then 'PARTIAL: result_recovery exists but the four functions are not all present (investigate; do not re-run blindly)'
    else 'D: migration 03 applied, 04 not applied'
  end as database_state;

-- 2. Prerequisites that migration 04 calls or references (EXPECT: all five rows present = true).
select * from (values
  ('table licenses',                         to_regclass('public.licenses') is not null),
  ('table license_reservations',             to_regclass('public.license_reservations') is not null),
  ('function commit_license_use(uuid)',      to_regprocedure('public.commit_license_use(uuid)') is not null),
  ('function reserve_license_use (7 args)',  to_regprocedure('public.reserve_license_use(text,integer,integer,integer,integer,text,text)') is not null),
  ('roles anon, authenticated, service_role', (select count(*) = 3 from pg_roles where rolname in ('anon','authenticated','service_role')))
) as t(prerequisite, present);

-- 3. Name collisions (EXPECT before: 0 rows). Anything already named like a migration-04 object is a STOP unless state says E.
select 'function' as kind, n.nspname as schema, p.proname as name, p.pronargs as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.proname in ('commit_license_use_with_result','list_recoverable_results','fetch_recoverable_result','purge_recoverable_results')
union all
select 'relation', n.nspname, c.relname, null
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relname in ('result_recovery','result_recovery_code_idx','result_recovery_expiry_idx');

-- 4. Privileges on the existing functions migration 04 builds on (EXPECT: anon = false, authenticated = false on every row; service_role = true).
select p.proname, p.pronargs as args,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('reserve_license_use','commit_license_use','release_license_use','finish_redelivery','purge_idempotency_hashes')
order by p.proname, p.pronargs;

-- 5. Balances: RECORD these four values now; the post-check prints them again. They change only with REAL customer use.
select count(*) as licenses, coalesce(sum(uses_remaining),0) as generations_remaining, coalesce(sum(max_uses - uses_remaining),0) as generations_spent,
       md5(coalesce(string_agg(code || ':' || uses_remaining || '/' || max_uses, ',' order by code), '')) as balance_fingerprint
from public.licenses;

-- 6. Reservation health. In a quiet window "live_now" for status reserved should be 0. Live in-flight steps are not harmful but make balance comparison noisy.
select status, count(*) as rows, count(*) filter (where status = 'reserved' and expires_at > now()) as live_now
from public.license_reservations group by status order by status;

-- 7. Is another session already running a migration? Check this before any retry after a timeout (EXPECT 0 rows).
select pid, state, now() - query_start as running_for, left(query, 80) as query_start_of
from pg_stat_activity
where datname = current_database() and pid <> pg_backend_pid()
  and (query ilike '%result_recovery%' or query ilike '%commit_license_use_with_result%');

-- 8. Size context (informational): migration 04 adds an empty table; stored copies stay under 24 hours.
select pg_size_pretty(pg_database_size(current_database())) as database_size;
