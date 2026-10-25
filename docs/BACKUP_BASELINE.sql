-- BACKUP BASELINE: READ-ONLY. SELECT statements only (the first line also puts the session in read-only mode). Prints one line per check as KIND|key|value.
--   MUST lines are compared before and after a restore (counts, fingerprints, migration status, permissions, function bodies): they have to be identical.
--   INFO lines are context (versions, sizes, extensions, roles) and may legitimately differ.
-- It prints COUNTS and MD5 FINGERPRINTS only. No license code, e-mail address, resume text or secret is ever printed.
-- Used by scripts/backup/backup-resume-db.sh (before the dump) and scripts/backup/verify-restore-local.sh (after a test restore).
-- Safe to run on production at any time; also usable by hand: psql -X -A -t -F'|' -f docs/BACKUP_BASELINE.sql
set session characteristics as transaction read only;

with q(kind, key, requires, sql) as (values
  -- ---- license data ----
  ('MUST', 'licenses.rows',                 'public.licenses', $$select count(*)::text as v from public.licenses$$),
  ('MUST', 'licenses.generations_remaining','public.licenses', $$select coalesce(sum(uses_remaining),0)::text as v from public.licenses$$),
  ('MUST', 'licenses.generations_max',      'public.licenses', $$select coalesce(sum(max_uses),0)::text as v from public.licenses$$),
  ('MUST', 'licenses.generations_spent',    'public.licenses', $$select coalesce(sum(max_uses - uses_remaining),0)::text as v from public.licenses$$),
  ('MUST', 'licenses.assigned',             'public.licenses', $$select count(*) filter (where assigned)::text as v from public.licenses$$),
  ('MUST', 'licenses.with_buyer_email',     'public.licenses', $$select count(buyer_email)::text as v from public.licenses$$),
  ('MUST', 'licenses.fingerprint',          'public.licenses', $$select md5(coalesce(string_agg(code || ':' || uses_remaining || '/' || max_uses || ':' || assigned::text, ',' order by code), '')) as v from public.licenses$$),
  -- ---- reservations (permanent charge record) ----
  ('MUST', 'reservations.rows',             'public.license_reservations', $$select count(*)::text as v from public.license_reservations$$),
  ('MUST', 'reservations.by_status',        'public.license_reservations', $$select coalesce(string_agg(status || '=' || n, ',' order by status), '') as v from (select status, count(*) n from public.license_reservations group by status) s$$),
  ('MUST', 'reservations.fingerprint',      'public.license_reservations', $$select md5(coalesce(string_agg(id::text || ':' || code || ':' || status, ',' order by id), '')) as v from public.license_reservations$$),
  ('MUST', 'reservations.tailor_runs',      'public.license_reservations', $$select coalesce(sum(tailor_count),0)::text as v from public.license_reservations$$),
  ('MUST', 'recovery_copies.rows',          'public.result_recovery',      $$select count(*)::text as v from public.result_recovery$$),
  -- ---- every public table: row counts ----
  ('MUST', 'public.table_row_counts', 'public.licenses', $$select coalesce(string_agg(t.table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t.table_name), false, true, '')))[1]::text, ',' order by t.table_name), '') as v from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE'$$),
  -- ---- structure ----
  ('MUST', 'schema.columns_hash',     'public.licenses', $$select md5(coalesce(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' order by table_name, column_name), '')) as v from information_schema.columns where table_schema = 'public'$$),
  ('MUST', 'schema.constraints_hash', 'public.licenses', $$select md5(coalesce(string_agg(c.relname || ':' || k.contype::text || ':' || pg_get_constraintdef(k.oid), ',' order by c.relname, k.contype::text, pg_get_constraintdef(k.oid)), '')) as v from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'$$),
  ('MUST', 'schema.indexes_hash',     'public.licenses', $$select md5(coalesce(string_agg(indexdef, ',' order by indexname), '')) as v from pg_indexes where schemaname = 'public'$$),
  ('MUST', 'schema.triggers_hash',    'public.licenses', $$select md5(coalesce(string_agg(c.relname || ':' || t.tgname || ':' || pg_get_triggerdef(t.oid), ',' order by c.relname, t.tgname), '')) as v from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal$$),
  ('INFO', 'schema.functions',        'public.licenses', $$select coalesce(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' order by p.proname, p.pronargs), '') as v from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')$$),
  ('MUST', 'schema.functions_hash',   'public.licenses', $$select md5(coalesce(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || p.prosecdef::text || ':' || coalesce(p.proconfig::text, '') || ':' || md5(p.prosrc), ',' order by p.proname, pg_get_function_identity_arguments(p.oid)), '')) as v from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')$$),
  -- ---- permissions ----
  ('MUST', 'perms.rls',               'public.licenses', $$select coalesce(string_agg(c.relname || '=' || c.relrowsecurity::text, ',' order by c.relname), '') as v from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'$$),
  ('MUST', 'perms.policies_hash',     'public.licenses', $$select md5(coalesce(string_agg(tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ',' order by tablename, policyname), '')) as v from pg_policies where schemaname = 'public'$$),
  ('MUST', 'perms.table_grants_hash', 'public.licenses', $$select md5(coalesce(string_agg(c.relname || ':' || r.rolname || ':' || p.priv, ',' order by c.relname, r.rolname, p.priv), '')) as v from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname) cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv) where n.nspname = 'public' and c.relkind = 'r' and exists (select 1 from pg_roles x where x.rolname = r.rolname) and has_table_privilege(r.rolname, c.oid, p.priv)$$),
  ('MUST', 'perms.public_table_grants','public.licenses', $$select count(*)::text as v from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and coalesce(c.relacl::text, '') ~ '(^\{|,)=[a-zA-Z]'$$),
  ('MUST', 'perms.function_exec_hash','public.licenses', $$select md5(coalesce(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || (case when exists (select 1 from pg_roles where rolname = 'anon') then has_function_privilege('anon', p.oid, 'execute')::text else 'norole' end) || ':' || (case when exists (select 1 from pg_roles where rolname = 'authenticated') then has_function_privilege('authenticated', p.oid, 'execute')::text else 'norole' end) || ':' || (case when exists (select 1 from pg_roles where rolname = 'service_role') then has_function_privilege('service_role', p.oid, 'execute')::text else 'norole' end) || ':' || (coalesce(p.proacl::text, '') ~ '(^\{|,)=X')::text, ',' order by p.proname, pg_get_function_identity_arguments(p.oid)), '')) as v from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')$$),
  ('MUST', 'perms.schema_usage',      'public.licenses', $$select coalesce(string_agg(rolname || '=' || has_schema_privilege(rolname, 'public', 'usage')::text, ',' order by rolname), '') as v from pg_roles where rolname in ('anon', 'authenticated', 'service_role')$$),
  ('MUST', 'perms.default_acl_hash',  'public.licenses', $$select md5(coalesce(string_agg(pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text || ':' || d.defaclacl::text, ',' order by pg_get_userbyid(d.defaclrole), d.defaclobjtype), '')) as v from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname = 'public'$$),
  -- ---- migration status ----
  ('MUST', 'migration.state', NULL, $$select case
        when to_regclass('public.license_reservations') is null then 'A: no reservation table (migration 01 not applied)'
        when to_regprocedure('public.reserve_license_use(text,integer,integer,integer,integer,text,text)') is null then 'B/C: migrations 01/02 only (03 not applied)'
        when to_regclass('public.result_recovery') is null then 'D: migration 03 applied, 04 not applied'
        else 'E: migrations 03 and 04 applied' end as v$$),
  ('MUST', 'migration.objects', NULL, $$select concat_ws(',',
        'licenses=' || (to_regclass('public.licenses') is not null)::text,
        'license_reservations=' || (to_regclass('public.license_reservations') is not null)::text,
        'commit_license_use=' || (to_regprocedure('public.commit_license_use(uuid)') is not null)::text,
        'reserve_5arg=' || (to_regprocedure('public.reserve_license_use(text,integer,integer,integer,integer)') is not null)::text,
        'reserve_7arg=' || (to_regprocedure('public.reserve_license_use(text,integer,integer,integer,integer,text,text)') is not null)::text,
        'finish_redelivery=' || (to_regprocedure('public.finish_redelivery(uuid,boolean)') is not null)::text,
        'purge_idempotency_hashes=' || (to_regprocedure('public.purge_idempotency_hashes()') is not null)::text,
        'result_recovery=' || (to_regclass('public.result_recovery') is not null)::text,
        'commit_with_result=' || (to_regprocedure('public.commit_license_use_with_result(uuid,text,text,text,text,text,integer)') is not null)::text) as v$$),
  ('MUST', 'migration.history_rows', 'supabase_migrations.schema_migrations', $$select count(*)::text as v from supabase_migrations.schema_migrations$$),
  -- ---- context: things that are NOT in the dump and should be understood before a migration ----
  ('INFO', 'server.version',        NULL, $$select current_setting('server_version') as v$$),
  ('INFO', 'database.size',         NULL, $$select pg_size_pretty(pg_database_size(current_database())) as v$$),
  ('INFO', 'extensions',            NULL, $$select coalesce(string_agg(extname || ' ' || extversion, ', ' order by extname), '') as v from pg_extension$$),
  ('INFO', 'schemas_with_tables',   NULL, $$select coalesce(string_agg(nspname || '=' || n, ', ' order by nspname), '') as v from (select n.nspname, count(*) n from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname !~ '^(pg_|information_schema)' group by n.nspname) s$$),
  ('INFO', 'roles_non_system',      NULL, $$select coalesce(string_agg(rolname || case when rolcanlogin then '(login)' else '' end, ', ' order by rolname), '') as v from pg_roles where rolname !~ '^pg_'$$),
  ('INFO', 'auth.users_rows',       'auth.users', $$select count(*)::text as v from auth.users$$),
  ('INFO', 'storage.objects_rows',  'storage.objects', $$select count(*)::text as v from storage.objects$$),
  ('INFO', 'vault.secrets_rows',    'vault.secrets', $$select count(*)::text as v from vault.secrets$$),
  ('INFO', 'cron.jobs',             'cron.job', $$select count(*)::text as v from cron.job$$)
)
select kind || '|' || key || '|' ||
       case when requires is not null and to_regclass(requires) is null then 'absent'
            else coalesce((xpath('/row/v/text()', query_to_xml(sql, false, true, '')))[1]::text, '') end as line
from q
order by kind desc, key;
