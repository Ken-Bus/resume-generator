-- Flex & Grace Resume Generator — license key usage limiting
-- Run this in the Supabase SQL editor for your project.

create table if not exists licenses (
  code text primary key,
  max_uses integer not null default 5,
  uses_remaining integer not null default 5,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

-- RLS is enabled with no policies, so anon/authenticated requests are
-- blocked outright. service_role bypasses RLS policy checks, but that
-- bypass doesn't substitute for a base Postgres GRANT — without one,
-- direct table access (e.g. an insert from the seed script, or the
-- plain select in verify-license.js) still fails with "permission
-- denied for table licenses". Grant it explicitly rather than relying
-- on this project's default privileges.
alter table licenses enable row level security;
grant usage on schema public to service_role;
grant select, insert, update, delete on licenses to service_role;

-- Atomically decrements uses_remaining by 1, guarded by uses_remaining > 0
-- so concurrent requests for the same code can never drive it negative.
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

-- Etsy delivery bookkeeping: which codes have been handed to a buyer (the Google Apps
-- Script reads and updates these columns directly with the service-role key), kept
-- separate from uses_remaining, which tracks generations left once a code is in a
-- customer's hands. buyer_email was added to the live table by hand on Sept 15, 2026.
alter table licenses add column if not exists assigned boolean not null default false;
alter table licenses add column if not exists assigned_at timestamptz;
alter table licenses add column if not exists buyer_email text;

-- Speeds up "find the first unassigned code" lookups as the table grows.
create index if not exists licenses_unassigned_idx on licenses (created_at) where assigned = false;

-- (The Zapier-era assign_next_license() function and its endpoint were removed on 2026-10-20.
-- It was never applied to production. Delivery is the Google Apps Script's job.)

-- ---------------------------------------------------------------------------
-- Reservation-based accounting with bounded failure protection (migration 20261020_01)
-- ---------------------------------------------------------------------------
drop function if exists reserve_license_use(text, integer);
drop function if exists release_license_use(uuid);
drop function if exists refund_tailor_use(uuid);

create table if not exists license_reservations (
  id uuid primary key default gen_random_uuid(),
  code text not null references licenses(code) on delete cascade,
  status text not null default 'reserved'
    check (status in ('reserved', 'committed', 'released', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  committed_at timestamptz,
  released_at timestamptz,
  -- True when a failed attempt may have cost money. Provider outages are released with false.
  failure_counted boolean not null default false,
  -- Tailoring runs already authorised against this paid generation, and failed runs given back.
  tailor_count integer not null default 0 check (tailor_count >= 0),
  tailor_refunds integer not null default 0 check (tailor_refunds >= 0)
);
alter table license_reservations add column if not exists failure_counted boolean not null default false;
alter table license_reservations add column if not exists tailor_refunds integer not null default 0 check (tailor_refunds >= 0);

create index if not exists license_reservations_code_idx
  on license_reservations (code, status, expires_at);
create index if not exists license_reservations_failures_idx
  on license_reservations (code, released_at) where status in ('released', 'expired');

-- Same lock-down as `licenses`: RLS on with no policies; only the server (service_role) may touch it.
alter table license_reservations enable row level security;
revoke all on license_reservations from public, anon, authenticated;
grant select, insert, update, delete on license_reservations to service_role;

-- Reserve one paid generation. outcome: reserved | exhausted | throttled | busy | not_found.
--   exhausted = no uses left;  throttled = too many costly failures recently (see retry_after_seconds);
--   busy = uses remain but all are held by in-flight requests.
create or replace function reserve_license_use(
  p_code text,
  p_lease_seconds integer default 45,
  p_fail_window_seconds integer default 900,
  p_fail_window_max integer default 6,
  p_fail_day_max integer default 30)
returns table(outcome text, reservation_id uuid, remaining integer, maximum integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  lic licenses%rowtype;
  active integer;
  new_id uuid;
  lease integer := least(greatest(coalesce(p_lease_seconds, 45), 5), 300);
  win integer := least(greatest(coalesce(p_fail_window_seconds, 900), 60), 86400);
  win_max integer := greatest(coalesce(p_fail_window_max, 6), 1);
  day_max integer := greatest(coalesce(p_fail_day_max, 30), 1);
  f_win integer;
  f_day integer;
  retry integer;
  t timestamptz;
begin
  -- The row lock serialises every reserve/commit for this code, so counting and inserting
  -- below cannot interleave with another request for the same code.
  select * into lic from licenses l where l.code = p_code for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::integer, null::integer, null::integer;
    return;
  end if;

  -- Housekeeping, bounded to this code: lapse overdue leases, drop old dead rows.
  update license_reservations r
     set status = 'expired'
   where r.code = p_code and r.status = 'reserved' and r.expires_at <= now();
  delete from license_reservations r
   where r.code = p_code and r.status in ('released', 'expired')
     and r.created_at < now() - interval '30 days';

  if lic.uses_remaining <= 0 then
    return query select 'exhausted'::text, null::uuid, lic.uses_remaining, lic.max_uses, null::integer;
    return;
  end if;

  -- Costly failures: lapsed leases (a worker died or timed out) and releases flagged as counted.
  select count(*) into f_win
    from license_reservations r
   where r.code = p_code
     and (r.status = 'expired' or (r.status = 'released' and r.failure_counted))
     and coalesce(r.released_at, r.expires_at) > now() - make_interval(secs => win);
  select count(*) into f_day
    from license_reservations r
   where r.code = p_code
     and (r.status = 'expired' or (r.status = 'released' and r.failure_counted))
     and coalesce(r.released_at, r.expires_at) > now() - interval '24 hours';

  if f_win >= win_max or f_day >= day_max then
    retry := 1;
    if f_win >= win_max then
      -- Allowed again when the win_max-th most recent failure leaves the window.
      select coalesce(r.released_at, r.expires_at) into t
        from license_reservations r
       where r.code = p_code
         and (r.status = 'expired' or (r.status = 'released' and r.failure_counted))
         and coalesce(r.released_at, r.expires_at) > now() - make_interval(secs => win)
       order by coalesce(r.released_at, r.expires_at) desc
       offset (win_max - 1) limit 1;
      retry := greatest(retry, ceil(extract(epoch from (t + make_interval(secs => win) - now())))::integer);
    end if;
    if f_day >= day_max then
      select coalesce(r.released_at, r.expires_at) into t
        from license_reservations r
       where r.code = p_code
         and (r.status = 'expired' or (r.status = 'released' and r.failure_counted))
         and coalesce(r.released_at, r.expires_at) > now() - interval '24 hours'
       order by coalesce(r.released_at, r.expires_at) desc
       offset (day_max - 1) limit 1;
      retry := greatest(retry, ceil(extract(epoch from (t + interval '24 hours' - now())))::integer);
    end if;
    return query select 'throttled'::text, null::uuid, lic.uses_remaining, lic.max_uses, least(retry, 86400);
    return;
  end if;

  select count(*) into active
    from license_reservations r
   where r.code = p_code and r.status = 'reserved' and r.expires_at > now();

  if lic.uses_remaining - active <= 0 then
    return query select 'busy'::text, null::uuid, lic.uses_remaining, lic.max_uses, null::integer;
  else
    insert into license_reservations (code, expires_at)
    values (p_code, now() + make_interval(secs => lease))
    returning id into new_id;
    return query select 'reserved'::text, new_id, lic.uses_remaining, lic.max_uses, null::integer;
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
-- p_counted = false for provider outages (they cost nothing and never count toward the failure budget).
-- The flag of the first release wins; a repeated release never changes it.
create or replace function release_license_use(p_reservation_id uuid, p_counted boolean default true)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  st text;
begin
  update license_reservations r
     set status = 'released', released_at = now(), failure_counted = coalesce(p_counted, true)
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
--   Provider outage (p_provider_fault = true): always given back, unlimited. It cost nothing.
--   Anything else (the AI ran but produced nothing usable): given back at most p_forgive_max
--   times per paid generation, then the failed run stays used, so repeated failures cannot
--   create unlimited AI calls. Returns the resulting tailor_count.
create or replace function refund_tailor_use(
  p_reservation_id uuid,
  p_provider_fault boolean default false,
  p_forgive_max integer default 2)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if p_provider_fault then
    update license_reservations r
       set tailor_count = greatest(r.tailor_count - 1, 0)
     where r.id = p_reservation_id and r.status = 'committed'
    returning r.tailor_count into n;
  else
    update license_reservations r
       set tailor_count = greatest(r.tailor_count - 1, 0), tailor_refunds = r.tailor_refunds + 1
     where r.id = p_reservation_id and r.status = 'committed' and r.tailor_refunds < p_forgive_max
    returning r.tailor_count into n;
  end if;
  if not found then
    select r.tailor_count into n from license_reservations r where r.id = p_reservation_id;
  end if;
  return n;
end;
$$;

-- Server-only: Supabase's default privileges can expose new functions to anon/authenticated.
revoke execute on function reserve_license_use(text, integer, integer, integer, integer) from public, anon, authenticated;
revoke execute on function commit_license_use(uuid)                                       from public, anon, authenticated;
revoke execute on function release_license_use(uuid, boolean)                             from public, anon, authenticated;
revoke execute on function consume_tailor_use(uuid, integer)                              from public, anon, authenticated;
revoke execute on function refund_tailor_use(uuid, boolean, integer)                      from public, anon, authenticated;
grant  execute on function reserve_license_use(text, integer, integer, integer, integer) to service_role;
grant  execute on function commit_license_use(uuid)                                       to service_role;
grant  execute on function release_license_use(uuid, boolean)                             to service_role;
grant  execute on function consume_tailor_use(uuid, integer)                              to service_role;
grant  execute on function refund_tailor_use(uuid, boolean, integer)                      to service_role;

-- ---------------------------------------------------------------------------
-- Lock the legacy function to the server (migration 20261020_02, F-11)
-- ---------------------------------------------------------------------------
revoke execute on function public.consume_license_use(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Durable request idempotency (migration 20261023_03)
-- ---------------------------------------------------------------------------
begin;

alter table license_reservations add column if not exists request_key text;
alter table license_reservations add column if not exists input_hash text;
alter table license_reservations add column if not exists redelivery_count integer not null default 0 check (redelivery_count >= 0);
alter table license_reservations add column if not exists redelivering_until timestamptz;
create index if not exists license_reservations_request_idx on license_reservations (code, request_key) where request_key is not null;

drop function if exists reserve_license_use(text, integer, integer, integer, integer);
drop function if exists reserve_license_use(text, integer, integer, integer, integer, text, text);

create or replace function reserve_license_use(
  p_code text,
  p_lease_seconds integer default 45,
  p_fail_window_seconds integer default 900,
  p_fail_window_max integer default 6,
  p_fail_day_max integer default 30,
  p_request_key text default null,
  p_input_hash text default null)
returns table(outcome text, reservation_id uuid, remaining integer, maximum integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  lic licenses%rowtype;
  active integer;
  new_id uuid;
  lease integer := least(greatest(coalesce(p_lease_seconds, 45), 5), 300);
  win integer := least(greatest(coalesce(p_fail_window_seconds, 900), 60), 86400);
  win_max integer := greatest(coalesce(p_fail_window_max, 6), 1);
  day_max integer := greatest(coalesce(p_fail_day_max, 30), 1);
  f_win integer;
  f_day integer;
  retry integer;
  t timestamptz;
  prior license_reservations%rowtype;
begin
  -- The row lock serialises every reserve/commit for this code, so counting and inserting
  -- below cannot interleave with another request for the same code.
  select * into lic from licenses l where l.code = p_code for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::integer, null::integer, null::integer;
    return;
  end if;

  -- Housekeeping, bounded to this code: lapse overdue leases, drop old dead rows.
  update license_reservations r
     set status = 'expired'
   where r.code = p_code and r.status = 'reserved' and r.expires_at <= now();
  delete from license_reservations r
   where r.code = p_code and r.status in ('released', 'expired')
     and r.created_at < now() - interval '30 days';

  -- Durable repeat protection. The page sends one request key per logical step and reuses it when a reply is lost. If a paid step with this
  -- key was already COMMITTED for this very input, the customer has paid for it: no second reservation and no second charge. The caller gets
  -- 'replay' (re-deliver the result without charging; the AI runs again, nothing is stored of the customer's text), 'replay_busy' (a re-delivery
  -- of it is already running) or 'replay_limit' (re-delivered too many times; ask the customer to contact us). This works across serverless
  -- instances, restarts and cold starts because the fact lives in the database, under the same row lock as every other reservation.
  if p_request_key is not null then
    select * into prior from license_reservations r
     where r.code = p_code and r.request_key = p_request_key and r.status = 'committed'
       and r.input_hash is not distinct from p_input_hash
       and r.committed_at > now() - interval '60 minutes'
     order by r.committed_at desc limit 1;
    if found then
      if prior.redelivering_until is not null and prior.redelivering_until > now() then
        return query select 'replay_busy'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer;
      elsif prior.redelivery_count >= 3 then
        return query select 'replay_limit'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer;
      else
        update license_reservations r
           set redelivery_count = r.redelivery_count + 1, redelivering_until = now() + make_interval(secs => greatest(lease, 60))
         where r.id = prior.id;
        return query select 'replay'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer;
      end if;
      return;
    end if;
  end if;

  if lic.uses_remaining <= 0 then
    return query select 'exhausted'::text, null::uuid, lic.uses_remaining, lic.max_uses, null::integer;
    return;
  end if;

  -- Costly failures: lapsed leases (a worker died or timed out) and releases flagged as counted.
  select count(*) into f_win
    from license_reservations r
   where r.code = p_code
     and (r.status = 'expired' or (r.status = 'released' and r.failure_counted))
     and coalesce(r.released_at, r.expires_at) > now() - make_interval(secs => win);
  select count(*) into f_day
    from license_reservations r
   where r.code = p_code
     and (r.status = 'expired' or (r.status = 'released' and r.failure_counted))
     and coalesce(r.released_at, r.expires_at) > now() - interval '24 hours';

  if f_win >= win_max or f_day >= day_max then
    retry := 1;
    if f_win >= win_max then
      -- Allowed again when the win_max-th most recent failure leaves the window.
      select coalesce(r.released_at, r.expires_at) into t
        from license_reservations r
       where r.code = p_code
         and (r.status = 'expired' or (r.status = 'released' and r.failure_counted))
         and coalesce(r.released_at, r.expires_at) > now() - make_interval(secs => win)
       order by coalesce(r.released_at, r.expires_at) desc
       offset (win_max - 1) limit 1;
      retry := greatest(retry, ceil(extract(epoch from (t + make_interval(secs => win) - now())))::integer);
    end if;
    if f_day >= day_max then
      select coalesce(r.released_at, r.expires_at) into t
        from license_reservations r
       where r.code = p_code
         and (r.status = 'expired' or (r.status = 'released' and r.failure_counted))
         and coalesce(r.released_at, r.expires_at) > now() - interval '24 hours'
       order by coalesce(r.released_at, r.expires_at) desc
       offset (day_max - 1) limit 1;
      retry := greatest(retry, ceil(extract(epoch from (t + interval '24 hours' - now())))::integer);
    end if;
    return query select 'throttled'::text, null::uuid, lic.uses_remaining, lic.max_uses, least(retry, 86400);
    return;
  end if;

  select count(*) into active
    from license_reservations r
   where r.code = p_code and r.status = 'reserved' and r.expires_at > now();

  if lic.uses_remaining - active <= 0 then
    return query select 'busy'::text, null::uuid, lic.uses_remaining, lic.max_uses, null::integer;
  else
    insert into license_reservations (code, expires_at, request_key, input_hash)
    values (p_code, now() + make_interval(secs => lease), p_request_key, p_input_hash)
    returning id into new_id;
    return query select 'reserved'::text, new_id, lic.uses_remaining, lic.max_uses, null::integer;
  end if;
end;
$$;

-- Re-delivery bookkeeping. p_ok = true: the result reached the customer's request (keep the count, free the slot).
-- p_ok = false: the re-delivery failed before producing a result: give the attempt back so the customer is not locked out by an outage.
create or replace function finish_redelivery(p_reservation_id uuid, p_ok boolean)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update license_reservations r
     set redelivering_until = null,
         redelivery_count = case when p_ok then r.redelivery_count else greatest(r.redelivery_count - 1, 0) end
   where r.id = p_reservation_id and r.status = 'committed'
  returning r.redelivery_count into n;
  return n;
end;
$$;

revoke execute on function reserve_license_use(text, integer, integer, integer, integer, text, text) from public, anon, authenticated;
revoke execute on function finish_redelivery(uuid, boolean)                                          from public, anon, authenticated;
grant  execute on function reserve_license_use(text, integer, integer, integer, integer, text, text) to service_role;
grant  execute on function finish_redelivery(uuid, boolean)                                          to service_role;

commit;
