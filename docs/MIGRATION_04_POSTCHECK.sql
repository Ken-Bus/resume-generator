-- MIGRATION 04 POST-MIGRATION VERIFICATION: READ-ONLY. Contains only SELECT statements. Nothing here calls list_recoverable_results or
-- purge_recoverable_results (they delete expired rows by design); recovery-function availability is proven from the catalog plus one
-- harmless lookup of a code and id that cannot exist. Safe to run any time, any number of times, in the Supabase SQL editor.
-- Run it right AFTER migration 04, again after the application deploy, and again after the first hourly purge.

-- 0. ONE-ROW VERDICT. Read this first. verdict = PASS only when every check below is satisfied; otherwise "FAIL: <first failing check>".
with
chk as (
  select
    (to_regclass('public.result_recovery') is not null) as table_exists,
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('commit_license_use_with_result','list_recoverable_results','fetch_recoverable_result','purge_recoverable_results')) = 4 as four_functions,
    coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.result_recovery')), false) as rls_on,
    coalesce(not has_table_privilege('anon', to_regclass('public.result_recovery'), 'select,insert,update,delete')
         and not has_table_privilege('authenticated', to_regclass('public.result_recovery'), 'select,insert,update,delete'), false) as table_closed_to_browser_roles,
    coalesce(has_table_privilege('service_role', to_regclass('public.result_recovery'), 'select') and has_table_privilege('service_role', to_regclass('public.result_recovery'), 'insert')
         and has_table_privilege('service_role', to_regclass('public.result_recovery'), 'delete'), false) as service_role_can_use_table,
    (select count(*) = 4 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('commit_license_use_with_result','list_recoverable_results','fetch_recoverable_result','purge_recoverable_results')
        and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public')
        and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
        and has_function_privilege('service_role', p.oid, 'execute')
        and coalesce(p.proacl::text, '') !~ '(^\{|,)=X') as functions_locked_down,
    exists (select 1 from pg_constraint where conrelid = to_regclass('public.result_recovery') and contype = 'c' and pg_get_constraintdef(oid) ~ '24(:00:00| hours)') as ceiling_24h_rule,
    (select count(*) from pg_constraint where conrelid = to_regclass('public.result_recovery') and contype = 'f') = 2 as two_foreign_keys,
    (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'result_recovery') = 3 as three_indexes,
    to_regprocedure('public.reserve_license_use(text,integer,integer,integer,integer,text,text)') is not null
      and to_regprocedure('public.finish_redelivery(uuid,boolean)') is not null
      and to_regprocedure('public.purge_idempotency_hashes()') is not null
      and to_regprocedure('public.commit_license_use(uuid)') is not null as migration_03_objects_intact,
    coalesce((select count(*) = 0 from public.result_recovery rr where rr.expires_at > rr.created_at + interval '24 hours'), false) as no_row_over_24h,
    coalesce((select count(*) = 0 from public.result_recovery rr where not exists (select 1 from public.license_reservations r where r.id = rr.reservation_id and r.status = 'committed')), false) as no_copy_without_committed_charge
)
select case
  when not table_exists then 'FAIL: result_recovery table missing'
  when not four_functions then 'FAIL: one of the four recovery functions is missing'
  when not rls_on then 'FAIL: row level security is off on result_recovery'
  when not table_closed_to_browser_roles then 'FAIL: anon or authenticated can touch result_recovery'
  when not service_role_can_use_table then 'FAIL: service_role cannot use result_recovery'
  when not functions_locked_down then 'FAIL: a recovery function is not security definer with search_path=public, or is executable by anon/authenticated/PUBLIC, or not by service_role'
  when not ceiling_24h_rule then 'FAIL: the 24-hour ceiling constraint is missing'
  when not two_foreign_keys then 'FAIL: expected 2 foreign keys (reservation, license)'
  when not three_indexes then 'FAIL: expected 3 indexes (primary key + 2)'
  when not migration_03_objects_intact then 'FAIL: a migration 03 / commit_license_use object is missing'
  when not no_row_over_24h then 'FAIL: a stored copy outlives the 24-hour ceiling'
  when not no_copy_without_committed_charge then 'FAIL: a stored copy has no committed charge behind it'
  else 'PASS' end as verdict,
  chk.*
from chk;

-- 1. Schema: the table's columns (EXPECT 10 rows: reservation_id uuid, code text, fn text, kid text, salt text, iv text, ct text, created_at timestamptz, expires_at timestamptz, plus none other).
select column_name, data_type, is_nullable from information_schema.columns
where table_schema = 'public' and table_name = 'result_recovery' order by ordinal_position;

-- 2. Constraints and indexes (EXPECT: 1 primary key, 2 foreign keys with ON DELETE CASCADE, 3 checks incl. the 24-hour rule; indexes: pkey + code_idx + expiry_idx).
select conname, contype, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = to_regclass('public.result_recovery') order by contype, conname;
select indexname from pg_indexes where schemaname = 'public' and tablename = 'result_recovery' order by indexname;

-- 3. Permissions on the table (EXPECT anon = false, authenticated = false, service_role = true; rls_on = true).
select has_table_privilege('anon', to_regclass('public.result_recovery'), 'select,insert,update,delete') as anon,
       has_table_privilege('authenticated', to_regclass('public.result_recovery'), 'select,insert,update,delete') as authenticated,
       has_table_privilege('service_role', to_regclass('public.result_recovery'), 'select,insert,update,delete') as service_role,
       (select relrowsecurity from pg_class where oid = to_regclass('public.result_recovery')) as rls_on;

-- 4. Permissions on the four functions (EXPECT 4 rows; security_definer = true; search_path_pinned = true; anon = false; authenticated = false; public_execute = false; service_role = true).
select p.proname, pg_get_function_identity_arguments(p.oid) as arguments, p.prosecdef as security_definer,
       exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public') as search_path_pinned,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       (coalesce(p.proacl::text, '') ~ '(^\{|,)=X') as public_execute,
       has_function_privilege('service_role', p.oid, 'execute') as service_role
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('commit_license_use_with_result','list_recoverable_results','fetch_recoverable_result','purge_recoverable_results')
order by p.proname;

-- 5. Recovery-function availability: the exact signatures the application calls (EXPECT every column true) and one harmless lookup that returns 0 rows.
select to_regprocedure('public.commit_license_use_with_result(uuid,text,text,text,text,text,integer)') is not null as commit_with_result,
       to_regprocedure('public.list_recoverable_results(text)') is not null as list_results,
       to_regprocedure('public.fetch_recoverable_result(text,uuid)') is not null as fetch_result,
       to_regprocedure('public.purge_recoverable_results()') is not null as purge_results;
select count(*) as rows_for_a_code_that_cannot_exist from public.fetch_recoverable_result('FG-ZZZZ-ZZZZ', '00000000-0000-0000-0000-000000000000'::uuid);   -- EXPECT 0

-- 6. Migration 03 and earlier objects still intact (EXPECT reserve_license_use ONCE with 7 args; the rest present; no anon/authenticated execute).
select p.proname, p.pronargs as args,
       has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('reserve_license_use','commit_license_use','release_license_use','finish_redelivery','purge_idempotency_hashes')
order by p.proname, p.pronargs;

-- 7. License-balance reconciliation. Compare with the PREFLIGHT query 5. licenses, generations_remaining, generations_spent and balance_fingerprint
--    must be IDENTICAL if no customer used the product in between; the migration itself must never change them. If they differ, compare
--    query 7b: every difference must be explained by committed reservations created after the preflight.
select count(*) as licenses, coalesce(sum(uses_remaining),0) as generations_remaining, coalesce(sum(max_uses - uses_remaining),0) as generations_spent,
       md5(coalesce(string_agg(code || ':' || uses_remaining || '/' || max_uses, ',' order by code), '')) as balance_fingerprint
from public.licenses;
--    7b. Committed charges and activity since the migration window (EXPECT committed_last_hour = 0 in a quiet window).
select count(*) filter (where status = 'committed') as committed_total,
       count(*) filter (where status = 'committed' and committed_at > now() - interval '1 hour') as committed_last_hour,
       count(*) filter (where status = 'reserved' and expires_at > now()) as in_flight_now
from public.license_reservations;

-- 8. Stored recovery copies (EXPECT 0 right after migration; afterwards: one per charged Analyze/Polish step, never older than 24 hours).
select count(*) as copies, count(*) filter (where expires_at <= now()) as expired_awaiting_cleanup,
       count(*) filter (where expires_at > created_at + interval '24 hours') as over_24h_ceiling,
       min(created_at) as oldest_copy, max(created_at) as newest_copy
from public.result_recovery;
--    8b. Orphans (EXPECT 0): copies with no committed charge behind them.
select count(*) as copies_without_committed_charge
from public.result_recovery rr
where not exists (select 1 from public.license_reservations r where r.id = rr.reservation_id and r.status = 'committed');

-- 9. After the first hourly purge has run (about an hour after deploy): expired_awaiting_cleanup in query 8 should be 0 or at most the rows that expired since the last run.
