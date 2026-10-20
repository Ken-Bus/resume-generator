-- Snapshot of the PRODUCTION database state as of 2026-10-20 (before this change), reconstructed from the
-- read-only catalog queries: public schema holds only `licenses` and consume_license_use (executable by PUBLIC
-- plus service_role); RLS on with no policies; no assign_next_license; no unassigned-code index.
-- Used to prove the migrations apply cleanly to the real starting point. Test-only; never run against Supabase.

create table licenses (
  code text primary key,
  max_uses integer not null default 5,
  uses_remaining integer not null default 5,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  assigned boolean not null default false,
  assigned_at timestamptz,
  buyer_email text
);
alter table licenses enable row level security;
grant usage on schema public to service_role;
grant select, insert, update, delete on licenses to service_role;

create or replace function consume_license_use(p_code text)
returns table(uses_remaining integer, max_uses integer, success boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_row licenses%rowtype;
begin
  update licenses
  set uses_remaining = licenses.uses_remaining - 1,
      last_used_at = now()
  where licenses.code = p_code and licenses.uses_remaining > 0
  returning * into updated_row;

  if updated_row.code is not null then
    return query select updated_row.uses_remaining, updated_row.max_uses, true;
  else
    return query
      select l.uses_remaining, l.max_uses, false
      from licenses l
      where l.code = p_code;
  end if;
end;
$$;
grant execute on function consume_license_use(text) to service_role;
-- (functions get EXECUTE for PUBLIC by default in Postgres, exactly as observed in production: acl {=X/postgres,...,service_role=X/postgres})
