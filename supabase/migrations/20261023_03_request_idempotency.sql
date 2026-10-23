-- Migration 03 — durable request idempotency for the paid AI steps (Analyze and AI Polish). ADDITIVE and backward compatible.
--
-- Problem: the "same request again" protection (replay.js) lived in memory on one serverless instance. If the reply to a successful, charged
-- request was lost and the retry reached a different or restarted instance, it was a brand-new request and charged a second generation.
--
-- Fix: the committed reservation remembers a hash of the page's request id (request_key) and a hash of the request's input (input_hash).
-- A repeat with the same key and the same input finds the committed row under the license row lock and is answered with 'replay': no
-- reservation, no second charge. The server then re-delivers the result (the AI runs again; nothing of the customer's text is stored here, only
-- two hashes). Re-delivery is limited (3 per paid step), one at a time, and a failed re-delivery gives its turn back.
--
-- Compatibility with the CURRENTLY DEPLOYED code: reserve_license_use keeps its first five parameters, defaults for the two new ones, and the same
-- result columns, so the old code calls it unchanged and never receives 'replay*' (it never sends a key). Apply this migration BEFORE deploying the
-- new code. The new code against a database WITHOUT this migration gets PGRST202 / 42883 and answers 503 "try again" (nothing charged).
--
-- Rollback (forward recovery, no data loss): re-run supabase/migrations/20261020_01_license_reservations.sql (it recreates the 5-argument
-- function; first `drop function reserve_license_use(text,integer,integer,integer,integer,text,text);`). The new columns are inert and may stay.
--
-- Run once in the Supabase SQL editor of the Resume project. Idempotent.

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
