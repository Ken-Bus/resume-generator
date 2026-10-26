-- MIGRATION 05 POST-MIGRATION VERIFICATION: READ-ONLY. Contains only SELECT statements. license_access_status is a read-only function and is called
-- only for a code that cannot exist. Safe to run any time, any number of times, in the Supabase SQL editor of the Resume project.
-- Run it right AFTER migration 05, again after the application deploy, and again after the first paid test.

-- 0. ONE-ROW VERDICT. Read this first. PASS only when every check below is satisfied.
with chk as (
  select
    (select count(*) = 3 from information_schema.columns where table_schema='public' and table_name='license_reservations' and column_name in ('kind','included_polish_by','included_from')) as three_columns,
    exists (select 1 from pg_indexes where schemaname='public' and indexname='license_reservations_included_polish_by_uq' and indexdef ilike '%unique%') as one_polish_per_analyze_index,
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='reserve_license_use') = 1
      and to_regprocedure('public.reserve_license_use(text,integer,integer,integer,integer,text,text,boolean)') is not null as one_reserve_with_8_args,
    to_regprocedure('public.commit_license_use_with_result(uuid,text,text,text,text,text,integer)') is not null
      and to_regprocedure('public.license_access_status(text,integer)') is not null as other_functions_present,
    (select count(*) = 3 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('reserve_license_use','commit_license_use_with_result','license_access_status')
        and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public')
        and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
        and has_function_privilege('service_role', p.oid, 'execute')
        and coalesce(p.proacl::text, '') !~ '(^\{|,)=X') as functions_locked_down,
    to_regprocedure('public.commit_license_use(uuid)') is not null and to_regprocedure('public.release_license_use(uuid,boolean)') is not null
      and to_regprocedure('public.finish_redelivery(uuid,boolean)') is not null and to_regprocedure('public.consume_tailor_use(uuid,integer)') is not null as earlier_functions_intact,
    to_regclass('public.result_recovery') is not null as recovery_table_intact,
    not exists (select 1 from license_reservations where included_polish_by is not null and (kind is distinct from 'analyze' or status <> 'committed')) as claims_only_on_paid_analyzes,
    not exists (select 1 from license_reservations a join license_reservations p on p.id = a.included_polish_by where p.included_from is distinct from a.id or p.code <> a.code or p.status <> 'committed') as claims_match_their_polish,
    not exists (select 1 from licenses where uses_remaining < 0 or uses_remaining > max_uses) as balances_in_range,
    (select access_state from license_access_status('FG-ZZZZ-ZZZZ')) = 'not_found' as access_function_answers
)
select case
  when not three_columns then 'FAIL: the three new columns are not all present'
  when not one_polish_per_analyze_index then 'FAIL: the unique index that enforces one included polish per Analyze is missing'
  when not one_reserve_with_8_args then 'FAIL: reserve_license_use is not exactly one function with 8 arguments'
  when not other_functions_present then 'FAIL: commit_license_use_with_result or license_access_status is missing'
  when not functions_locked_down then 'FAIL: a migration-05 function is open to anon/authenticated/public or lacks security definer / pinned search_path'
  when not earlier_functions_intact then 'FAIL: a function from migrations 01-04 is missing'
  when not recovery_table_intact then 'FAIL: result_recovery is missing'
  when not claims_only_on_paid_analyzes then 'FAIL: an included-polish claim sits on a row that is not a committed Analyze'
  when not claims_match_their_polish then 'FAIL: an included-polish claim does not match the Polish that made it'
  when not balances_in_range then 'FAIL: a balance is outside 0..max'
  when not access_function_answers then 'FAIL: license_access_status does not answer'
  else 'PASS' end as verdict, chk.*
from chk;

-- 1. Balance fingerprint (EXPECT: identical to the preflight value taken just before; migration 05 changes no balance. After paid tests it changes only by those tests).
select count(*) as license_rows, coalesce(sum(uses_remaining),0) as total_uses_remaining,
       coalesce(md5(string_agg(code || ':' || max_uses || ':' || uses_remaining, ',' order by code)), '') as balance_fingerprint
from licenses;

-- 2. Reservation rows by status (EXPECT: the same counts as the preflight, plus only what happened since).
select status, count(*) as rows from license_reservations group by status order by status;

-- 3. Included-polish ledger (EXPECT right after the migration: 0 analyzes with a credit, 0 claimed; after the first new Analyze: 1 open; after its included Polish: 1 claimed).
select count(*) filter (where kind = 'analyze' and status = 'committed' and included_polish_by is null) as open_credits,
       count(*) filter (where included_polish_by is not null) as used_credits,
       count(*) filter (where kind is not null) as rows_with_kind
from license_reservations;

-- 4. Function signatures now in place (EXPECT: reserve_license_use 8 args; commit_license_use_with_result 7 args; license_access_status 2 args).
select p.proname, pg_get_function_identity_arguments(p.oid) as identity_arguments
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('reserve_license_use','commit_license_use_with_result','license_access_status') order by 1;

-- 5. Privileges (EXPECT: anon = false, authenticated = false, service_role = true on every row).
select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('reserve_license_use','commit_license_use_with_result','license_access_status') order by 1;
