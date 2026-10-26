-- MIGRATION 03 PREFLIGHT: READ-ONLY. Contains only SELECT statements. Safe to run any time, any number of times, in the Supabase SQL editor.
-- Run it BEFORE the migration (expect state "B/C"), AFTER the migration (expect state "D"), and again if a command times out (before any retry).

-- 1. Which database state is this?  A = no reservation table | B/C = migration 01(+02) | D = +03 | R = after rollback (5-arg function, new columns kept)
select
  case
    when not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'license_reservations') then 'A: no reservation table (apply 01 and 02 first)'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'reserve_license_use' and p.pronargs = 7)
         and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'finish_redelivery')
         and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'purge_idempotency_hashes')
      then 'D: migration 03 applied'
    when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'license_reservations' and column_name = 'request_key')
      then 'R: rolled back (5-argument function, new columns kept)'
    else 'B/C: migrations 01/02 only (03 not applied)'
  end as database_state;

-- 2. Functions and their argument counts (expect after migration: reserve_license_use appears ONCE with 7)
select p.proname, p.pronargs as args, p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('reserve_license_use','commit_license_use','release_license_use','consume_tailor_use','refund_tailor_use','finish_redelivery','purge_idempotency_hashes','consume_license_use')
order by p.proname, p.pronargs;

-- 3. New columns (expect 5 rows after migration)
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'license_reservations' and column_name in ('request_key','input_hash','redelivery_count','redelivering_until','redelivery_lapses')
order by column_name;

-- 4. Privileges (expect anon = false and authenticated = false on every row; service_role = true)
select p.proname, p.pronargs as args,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('reserve_license_use','commit_license_use','release_license_use','consume_tailor_use','refund_tailor_use','finish_redelivery','purge_idempotency_hashes','consume_license_use')
order by p.proname, p.pronargs;
select has_table_privilege('anon', to_regclass('public.license_reservations'), 'select,insert,update,delete') as anon_table,
       has_table_privilege('authenticated', to_regclass('public.license_reservations'), 'select,insert,update,delete') as authenticated_table,
       (select relrowsecurity from pg_class where oid = to_regclass('public.license_reservations')) as rls_on;

-- 5. Balances: record before, compare after. The fingerprint changes with REAL customer use; the migration itself changes nothing here.
select count(*) as licenses, coalesce(sum(uses_remaining),0) as generations_remaining, coalesce(sum(max_uses - uses_remaining),0) as generations_spent,
       md5(coalesce(string_agg(code || ':' || uses_remaining || '/' || max_uses, ',' order by code), '')) as balance_fingerprint
from public.licenses;

-- 6. Reservation health (in-flight steps right now; a quiet window shows 0 live). In state A this query errors because the table does not exist: expected.
select status, count(*) as rows, count(*) filter (where status = 'reserved' and expires_at > now()) as live_now
from public.license_reservations group by status order by status;

-- 7. Is a migration session still running? Check this BEFORE any retry after a timeout.
select pid, state, now() - query_start as running_for, left(query, 80) as query_start_of
from pg_stat_activity
where datname = current_database() and pid <> pg_backend_pid()
  and (query ilike '%request_idempotency%' or query ilike '%finish_redelivery%' or query ilike '%reserve_license_use%' and query ilike '%create or replace%');
