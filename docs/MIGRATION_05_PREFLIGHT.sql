-- MIGRATION 05 PREFLIGHT: READ-ONLY. Contains only SELECT statements and writes nothing. Safe to run any time, any number of times, in the Supabase SQL
-- editor of the Resume project. Run it BEFORE migration 05 and keep the output next to the post-check output.
-- Each numbered query states what to expect. STOP conditions are named in docs/MIGRATION_05_REVIEW_PACKAGE.md.

-- 1. Which database state is this?  EXPECT BEFORE migration 05: "E: migrations 03 and 04 applied, 05 not applied".
select
  case
    when to_regclass('public.license_reservations') is null then 'A: no reservation table (apply 01, 02, 03, 04 first)'
    when to_regprocedure('public.reserve_license_use(text,integer,integer,integer,integer,text,text,boolean)') is not null
         and to_regprocedure('public.license_access_status(text,integer)') is not null then 'F: migration 05 already applied (run the post-check instead)'
    when to_regprocedure('public.reserve_license_use(text,integer,integer,integer,integer,text,text)') is null then 'B/C/R: migration 03 NOT applied (apply 03 and 04 first)'
    when to_regclass('public.result_recovery') is null
         or to_regprocedure('public.commit_license_use_with_result(uuid,text,text,text,text,text,integer)') is null then 'D: migration 04 NOT applied (apply 04 first)'
    else 'E: migrations 03 and 04 applied, 05 not applied'
  end as database_state;

-- 2. Prerequisites migration 05 builds on (EXPECT: every row present = true).
select * from (values
  ('table licenses',                                  to_regclass('public.licenses') is not null),
  ('table license_reservations',                      to_regclass('public.license_reservations') is not null),
  ('table result_recovery',                           to_regclass('public.result_recovery') is not null),
  ('column licenses.last_used_at',                    exists (select 1 from information_schema.columns where table_schema='public' and table_name='licenses' and column_name='last_used_at')),
  ('function commit_license_use(uuid)',               to_regprocedure('public.commit_license_use(uuid)') is not null),
  ('function release_license_use(uuid,boolean)',      to_regprocedure('public.release_license_use(uuid,boolean)') is not null),
  ('function reserve_license_use (7 args)',           to_regprocedure('public.reserve_license_use(text,integer,integer,integer,integer,text,text)') is not null),
  ('function commit_license_use_with_result (7 args)', to_regprocedure('public.commit_license_use_with_result(uuid,text,text,text,text,text,integer)') is not null),
  ('roles anon, authenticated, service_role',         (select count(*) = 3 from pg_roles where rolname in ('anon','authenticated','service_role')))
) as t(prerequisite, present);

-- 3. Name collisions (EXPECT before: 0 rows). Anything already named like a migration-05 object is a STOP unless the state above says F.
select 'column' as kind, column_name as name from information_schema.columns
 where table_schema='public' and table_name='license_reservations' and column_name in ('kind','included_polish_by','included_from')
union all
select 'index', indexname from pg_indexes where schemaname='public' and indexname in ('license_reservations_included_polish_by_uq','license_reservations_included_open_idx','license_reservations_included_from_idx')
union all
select 'function', p.proname || '/' || p.pronargs from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname = 'license_access_status';

-- 4. Exactly which versions of the two functions that migration 05 replaces exist right now (EXPECT: reserve_license_use one row with 7 args; commit_license_use_with_result one row with 7 args).
select p.proname, p.pronargs as args, pg_get_function_identity_arguments(p.oid) as identity_arguments
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('reserve_license_use','commit_license_use_with_result') order by 1, 2;

-- 5. Nothing is mid-flight (EXPECT: 0). Apply the migration when no paid step is running; a running step would still finish, but a quiet moment makes the
--    post-check unambiguous. (A reservation counts only while its lease has not run out.)
select count(*) as live_reservations_now from license_reservations where status = 'reserved' and expires_at > now();

-- 6. Size and shape of the data the migration will read (informational; keep for comparison with the post-check).
select status, count(*) as rows, min(created_at) as oldest, max(created_at) as newest from license_reservations group by status order by status;
select count(*) as licenses, coalesce(sum(uses_remaining),0) as total_uses_remaining, coalesce(sum(max_uses),0) as total_max_uses from licenses;

-- 7. Balance sanity (EXPECT: 0 rows). A balance outside 0..max would be a problem to understand BEFORE changing billing functions.
select code_hash, uses_remaining, max_uses from (select md5(code) as code_hash, uses_remaining, max_uses from licenses) l where uses_remaining < 0 or uses_remaining > max_uses limit 20;

-- 8. A fingerprint of every balance (KEEP THIS VALUE: the post-check recomputes it; migration 05 must not change it).
select count(*) as license_rows, coalesce(sum(uses_remaining),0) as total_uses_remaining,
       coalesce(md5(string_agg(code || ':' || max_uses || ':' || uses_remaining, ',' order by code)), '') as balance_fingerprint
from licenses;

-- 9. Privileges on the functions about to be replaced (EXPECT: anon = false, authenticated = false on every row; service_role = true).
select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('reserve_license_use','commit_license_use_with_result','commit_license_use') order by 1;
