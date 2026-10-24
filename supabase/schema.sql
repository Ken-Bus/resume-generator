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
alter table license_reservations add column if not exists redelivery_lapses integer not null default 0 check (redelivery_lapses >= 0);
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

  -- Data minimisation: the input hash of a step is only useful while the step can still be re-delivered (24 hours).
  update license_reservations r set input_hash = null
   where r.code = p_code and r.input_hash is not null and coalesce(r.committed_at, r.created_at) < now() - interval '24 hours';

  -- Durable repeat protection (see the header for the full decision table). This works across serverless instances, restarts and cold starts
  -- because the facts live in the database, under the same row lock as every other reservation.
  if p_request_key is not null then
    select * into prior from license_reservations r
     where r.code = p_code and r.request_key = p_request_key
       and (r.status = 'committed' or (r.status = 'reserved' and r.expires_at > now()))
     order by (r.status = 'committed') desc, r.created_at desc limit 1;
    if found then
      if prior.status = 'reserved' then
        -- the same request id is already running (a double send, a second tab, a retry while the first is still working)
        if prior.input_hash is distinct from p_input_hash then
          return query select 'key_conflict'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer;
        else
          return query select 'replay_busy'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer;
        end if;
      elsif prior.committed_at <= now() - interval '24 hours' then
        return query select 'key_expired'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer;
      elsif prior.input_hash is distinct from p_input_hash then
        return query select 'key_conflict'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer;
      else
        if prior.redelivering_until is not null and prior.redelivering_until <= now() then
          -- a re-delivery that started and never finished (the worker died): note it so it is not held against the customer
          update license_reservations r set redelivery_lapses = r.redelivery_lapses + 1, redelivering_until = null
           where r.id = prior.id returning * into prior;
        end if;
        if prior.redelivering_until is not null then
          return query select 'replay_busy'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer;
        elsif prior.redelivery_count - least(prior.redelivery_lapses, 2) >= 3 then
          return query select 'replay_limit'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer;
        else
          update license_reservations r
             set redelivery_count = r.redelivery_count + 1, redelivering_until = now() + make_interval(secs => greatest(lease, 60))
           where r.id = prior.id;
          return query select 'replay'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer;
        end if;
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

-- Daily housekeeping (called by check-code-supply): erase input hashes older than 24 hours for EVERY code, and drop the request key from rows that
-- were never paid (released / expired). Returns the number of rows touched. Idempotent.
create or replace function purge_idempotency_hashes()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer; m integer;
begin
  update license_reservations r set input_hash = null
   where r.input_hash is not null and coalesce(r.committed_at, r.created_at) < now() - interval '24 hours';
  get diagnostics n = row_count;
  update license_reservations r set request_key = null
   where r.request_key is not null and r.status in ('released', 'expired') and r.created_at < now() - interval '24 hours';
  get diagnostics m = row_count;
  return n + m;
end;
$$;

revoke execute on function reserve_license_use(text, integer, integer, integer, integer, text, text) from public, anon, authenticated;
revoke execute on function finish_redelivery(uuid, boolean)                                          from public, anon, authenticated;
revoke execute on function purge_idempotency_hashes()                                                 from public, anon, authenticated;
grant  execute on function reserve_license_use(text, integer, integer, integer, integer, text, text) to service_role;
grant  execute on function finish_redelivery(uuid, boolean)                                          to service_role;
grant  execute on function purge_idempotency_hashes()                                                 to service_role;

commit;

-- ---------------------------------------------------------------------------
-- Temporary encrypted result recovery (migration 20261024_04)
-- ---------------------------------------------------------------------------
begin;

create table if not exists result_recovery (
  reservation_id uuid primary key references license_reservations(id) on delete cascade,
  code text not null references licenses(code) on delete cascade,
  fn text not null check (fn in ('analyze', 'polish')),
  kid text not null,
  salt text not null,
  iv text not null,
  ct text not null check (length(ct) between 1 and 400000),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at and expires_at <= created_at + interval '24 hours')       -- the 24-hour ceiling is a table rule, not just application code
);
create index if not exists result_recovery_code_idx on result_recovery (code, expires_at);
create index if not exists result_recovery_expiry_idx on result_recovery (expires_at);

alter table result_recovery enable row level security;
revoke all on result_recovery from public, anon, authenticated;
grant select, insert, update, delete on result_recovery to service_role;

-- Commit the generation AND store the encrypted copy, atomically. outcome as commit_license_use (committed | already_committed | released | expired |
-- exhausted | not_found). result_saved is true only when a copy exists for this step after the call.
create or replace function commit_license_use_with_result(
  p_reservation_id uuid,
  p_fn text,
  p_kid text,
  p_salt text,
  p_iv text,
  p_ct text,
  p_keep_seconds integer default 86400)
returns table(outcome text, remaining integer, maximum integer, result_saved boolean, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_code text;
  keep integer := least(greatest(coalesce(p_keep_seconds, 86400), 60), 86400);
  v_expires timestamptz;
begin
  if p_fn not in ('analyze', 'polish') or coalesce(length(p_ct), 0) = 0 or length(p_ct) > 400000
     or coalesce(length(p_kid), 0) = 0 or coalesce(length(p_salt), 0) = 0 or coalesce(length(p_iv), 0) = 0 then
    raise exception 'invalid recovery copy' using errcode = '22023';                        -- aborts the whole call: nothing is charged
  end if;
  select r.code into v_code from license_reservations r where r.id = p_reservation_id;
  select * into c from commit_license_use(p_reservation_id);                                  -- the existing, tested commit, in THIS transaction
  if c.outcome in ('committed', 'already_committed') then
    insert into result_recovery (reservation_id, code, fn, kid, salt, iv, ct, expires_at)
    values (p_reservation_id, v_code, p_fn, p_kid, p_salt, p_iv, p_ct, now() + make_interval(secs => keep))
    on conflict (reservation_id) do nothing;                                                  -- one copy per paid step; the first one is kept
    select rr.expires_at into v_expires from result_recovery rr where rr.reservation_id = p_reservation_id;
    return query select c.outcome, c.remaining, c.maximum, (v_expires is not null and v_expires > now()), v_expires;
  else
    return query select c.outcome, c.remaining, c.maximum, false, null::timestamptz;
  end if;
end;
$$;

-- What the customer could restore right now (no content): newest first, at most 3, never expired. Expired rows of this code are deleted on the way.
create or replace function list_recoverable_results(p_code text)
returns table(id uuid, fn text, created_at timestamptz, expires_at timestamptz, remaining integer, maximum integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from result_recovery rr where rr.code = p_code and rr.expires_at <= now();
  return query
    select rr.reservation_id, rr.fn, rr.created_at, rr.expires_at, l.uses_remaining, l.max_uses
      from result_recovery rr join licenses l on l.code = rr.code
     where rr.code = p_code and rr.expires_at > now()
     order by rr.created_at desc limit 3;
end;
$$;

-- The encrypted copy of ONE step of THIS code. Nothing is returned for another code's step, an unknown id, or an expired copy.
create or replace function fetch_recoverable_result(p_code text, p_id uuid)
returns table(id uuid, fn text, kid text, salt text, iv text, ct text, created_at timestamptz, expires_at timestamptz, remaining integer, maximum integer)
language sql
security definer
set search_path = public
as $$
  select rr.reservation_id, rr.fn, rr.kid, rr.salt, rr.iv, rr.ct, rr.created_at, rr.expires_at, l.uses_remaining, l.max_uses
    from result_recovery rr join licenses l on l.code = rr.code
   where rr.reservation_id = p_id and rr.code = p_code and rr.expires_at > now();
$$;

-- Hourly cleanup (a Netlify scheduled function calls it). Returns the number of expired copies removed.
create or replace function purge_recoverable_results()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from result_recovery rr where rr.expires_at <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function commit_license_use_with_result(uuid, text, text, text, text, text, integer) from public, anon, authenticated;
revoke execute on function list_recoverable_results(text)                                              from public, anon, authenticated;
revoke execute on function fetch_recoverable_result(text, uuid)                                        from public, anon, authenticated;
revoke execute on function purge_recoverable_results()                                                 from public, anon, authenticated;
grant  execute on function commit_license_use_with_result(uuid, text, text, text, text, text, integer) to service_role;
grant  execute on function list_recoverable_results(text)                                              to service_role;
grant  execute on function fetch_recoverable_result(text, uuid)                                        to service_role;
grant  execute on function purge_recoverable_results()                                                 to service_role;

commit;
