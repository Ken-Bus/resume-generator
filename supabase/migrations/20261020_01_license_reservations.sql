-- Migration 01 of 02 — reservation-based license accounting (additive).
--
-- Safe to apply BEFORE the code deploy: it only adds a table and functions. Nothing that
-- exists today (verify-license, consume_license_use, the Google Apps Script's GET/PATCH on
-- `licenses`, check-code-supply) reads or writes these objects, and no `licenses` row is
-- touched. The old browser keeps working unchanged until the new code ships.
--
-- Model: a paid generation is reserved first (atomic, under a row lock on the license),
-- the AI runs, and only after a validated result is the reservation committed (which
-- decrements licenses.uses_remaining). A failed attempt is released, and a crashed or
-- timed-out attempt simply lets its lease expire. A failure can never permanently cost a
-- use, and simultaneous requests can never hold more reservations than uses remain.
--
-- Apply this file once, in the Supabase SQL editor of the Resume project. It is idempotent.

create table if not exists license_reservations (
  id uuid primary key default gen_random_uuid(),
  code text not null references licenses(code) on delete cascade,
  status text not null default 'reserved'
    check (status in ('reserved', 'committed', 'released', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  committed_at timestamptz,
  released_at timestamptz,
  -- Number of tailoring runs already authorised against this paid generation.
  tailor_count integer not null default 0 check (tailor_count >= 0)
);

create index if not exists license_reservations_code_idx
  on license_reservations (code, status, expires_at);

-- Same lock-down as `licenses`: RLS on with no policies; only the server (service_role) may touch it.
alter table license_reservations enable row level security;
revoke all on license_reservations from public, anon, authenticated;
grant select, insert, update, delete on license_reservations to service_role;

-- Reserve one paid generation. outcome: reserved | exhausted | busy | not_found.
--   exhausted = no uses left;  busy = uses remain but all are held by in-flight requests.
create or replace function reserve_license_use(p_code text, p_lease_seconds integer default 45)
returns table(outcome text, reservation_id uuid, remaining integer, maximum integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  lic licenses%rowtype;
  active integer;
  new_id uuid;
  lease integer := least(greatest(coalesce(p_lease_seconds, 45), 5), 300);
begin
  -- The row lock serialises every reserve/commit for this code, so counting and inserting
  -- below cannot interleave with another request for the same code.
  select * into lic from licenses l where l.code = p_code for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::integer, null::integer;
    return;
  end if;

  -- Housekeeping, bounded to this code: lapse overdue leases, drop old dead rows.
  update license_reservations r
     set status = 'expired'
   where r.code = p_code and r.status = 'reserved' and r.expires_at <= now();
  delete from license_reservations r
   where r.code = p_code and r.status in ('released', 'expired')
     and r.created_at < now() - interval '30 days';

  select count(*) into active
    from license_reservations r
   where r.code = p_code and r.status = 'reserved' and r.expires_at > now();

  if lic.uses_remaining <= 0 then
    return query select 'exhausted'::text, null::uuid, lic.uses_remaining, lic.max_uses;
  elsif lic.uses_remaining - active <= 0 then
    return query select 'busy'::text, null::uuid, lic.uses_remaining, lic.max_uses;
  else
    insert into license_reservations (code, expires_at)
    values (p_code, now() + make_interval(secs => lease))
    returning id into new_id;
    return query select 'reserved'::text, new_id, lic.uses_remaining, lic.max_uses;
  end if;
end;
$$;

-- Commit a reservation after a validated AI result: decrements the license exactly once.
-- Idempotent. outcome: committed | already_committed | released | expired | exhausted | not_found.
-- A late commit (lease already lapsed) still succeeds if a slot is free, otherwise it fails
-- and the caller discards the result: a customer is never charged beyond max_uses.
create or replace function commit_license_use(p_reservation_id uuid)
returns table(outcome text, remaining integer, maximum integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  lic licenses%rowtype;
  res license_reservations%rowtype;
  others integer;
  new_remaining integer;
begin
  select r.code into v_code from license_reservations r where r.id = p_reservation_id;
  if v_code is null then
    return query select 'not_found'::text, null::integer, null::integer;
    return;
  end if;

  -- Lock order is always license row first, then reservation row.
  select * into lic from licenses l where l.code = v_code for update;
  select * into res from license_reservations r where r.id = p_reservation_id for update;

  if res.status = 'committed' then
    return query select 'already_committed'::text, lic.uses_remaining, lic.max_uses;
    return;
  end if;
  if res.status = 'released' then
    return query select 'released'::text, lic.uses_remaining, lic.max_uses;
    return;
  end if;

  if res.status = 'expired' or res.expires_at <= now() then
    select count(*) into others
      from license_reservations r
     where r.code = v_code and r.id <> res.id and r.status = 'reserved' and r.expires_at > now();
    if lic.uses_remaining - others <= 0 then
      update license_reservations r set status = 'expired' where r.id = res.id and r.status = 'reserved';
      return query select (case when lic.uses_remaining <= 0 then 'exhausted' else 'expired' end)::text,
                          lic.uses_remaining, lic.max_uses;
      return;
    end if;
  end if;

  if lic.uses_remaining <= 0 then
    return query select 'exhausted'::text, lic.uses_remaining, lic.max_uses;
    return;
  end if;

  update licenses
     set uses_remaining = licenses.uses_remaining - 1,
         last_used_at = now()
   where licenses.code = v_code
  returning licenses.uses_remaining into new_remaining;

  update license_reservations r
     set status = 'committed', committed_at = now()
   where r.id = p_reservation_id;

  return query select 'committed'::text, new_remaining, lic.max_uses;
end;
$$;

-- Release a reservation after a failed attempt. Idempotent; returns the resulting status.
create or replace function release_license_use(p_reservation_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  st text;
begin
  update license_reservations r
     set status = 'released', released_at = now()
   where r.id = p_reservation_id and r.status = 'reserved';
  if found then
    return 'released';
  end if;
  select r.status into st from license_reservations r where r.id = p_reservation_id;
  return coalesce(st, 'not_found');
end;
$$;

-- Authorise one tailoring run against a committed (paid) generation, capped at p_max.
-- outcome: ok | limit | invalid | not_found. Atomic, so parallel replays cannot exceed the cap.
create or replace function consume_tailor_use(p_reservation_id uuid, p_max integer)
returns table(outcome text, used integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
  st text;
  cnt integer;
begin
  update license_reservations r
     set tailor_count = r.tailor_count + 1
   where r.id = p_reservation_id and r.status = 'committed' and r.tailor_count < p_max
  returning r.tailor_count into n;
  if found then
    return query select 'ok'::text, n;
    return;
  end if;

  select r.status, r.tailor_count into st, cnt from license_reservations r where r.id = p_reservation_id;
  if st is null then
    return query select 'not_found'::text, null::integer;
  elsif st <> 'committed' then
    return query select 'invalid'::text, cnt;
  else
    return query select 'limit'::text, cnt;
  end if;
end;
$$;

-- Give back a tailoring run when the AI call failed. Never goes below zero.
create or replace function refund_tailor_use(p_reservation_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update license_reservations r
     set tailor_count = greatest(r.tailor_count - 1, 0)
   where r.id = p_reservation_id and r.status = 'committed'
  returning r.tailor_count into n;
  return n;
end;
$$;

-- Server-only: Supabase's default privileges can expose new functions to anon/authenticated.
revoke execute on function reserve_license_use(text, integer) from public, anon, authenticated;
revoke execute on function commit_license_use(uuid)           from public, anon, authenticated;
revoke execute on function release_license_use(uuid)          from public, anon, authenticated;
revoke execute on function consume_tailor_use(uuid, integer)  from public, anon, authenticated;
revoke execute on function refund_tailor_use(uuid)            from public, anon, authenticated;
grant  execute on function reserve_license_use(text, integer) to service_role;
grant  execute on function commit_license_use(uuid)           to service_role;
grant  execute on function release_license_use(uuid)          to service_role;
grant  execute on function consume_tailor_use(uuid, integer)  to service_role;
grant  execute on function refund_tailor_use(uuid)            to service_role;
