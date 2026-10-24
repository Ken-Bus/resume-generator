-- Migration 03: durable request idempotency for the paid AI steps (Analyze and AI Polish). ADDITIVE and backward compatible.
-- (Revision 2, after independent review: conflicting request-id reuse is REFUSED, retention is explicit, abandoned leases are handled.)
--
-- Problem: the "same request again" protection (replay.js) lived in memory on one serverless instance. If the reply to a successful, charged
-- request was lost and the retry reached a different or restarted instance, it was a brand-new request and charged a second generation.
--
-- Model. The page sends one request id per logical step and reuses it only to retry THAT step. The server stores, on the reservation row,
-- request_key (a keyed hash of the id) and input_hash (a keyed hash of the request's input). Under the license row lock, a reserve call that
-- carries a key finds any row for the same code and key and decides:
--   same id, committed, same input, within 24 h   -> 'replay'        the step was paid; no reservation, no charge; the server re-delivers
--   same id, committed, same input, replay running  -> 'replay_busy'
--   same id, committed, same input, limit reached   -> 'replay_limit' (3 re-deliveries; abandoned leases give back up to 2)
--   same id, committed, DIFFERENT input             -> 'key_conflict' the id is spent on another input: refuse, charge nothing, ask for a new id
--   same id, committed, older than 24 h             -> 'key_expired'  too old to recover: refuse, charge nothing, ask for a new id
--   same id, still reserved (running)               -> 'replay_busy' (same input) or 'key_conflict' (different input)
--   no row for the id                               -> an ordinary new reservation (charged only on commit, as before)
-- A retry therefore can never become a second charge; only a NEW id (a deliberate new operation) can.
--
-- Retention (explicit). Committed reservation rows are the permanent accounting record and already exist; the request_key on them is kept with
-- them (a keyed hash of a random id: it identifies nothing about the customer), so a stale id is refused forever instead of being charged.
-- input_hash (derived from the resume text) is erased 24 hours after the step, by reserve_license_use for the code in question and by
-- purge_idempotency_hashes() for every code (called daily by check-code-supply). No resume text, AI output or contact detail is stored.
--
-- Compatibility with the CURRENTLY DEPLOYED code: reserve_license_use keeps its first five parameters, defaults for the two new ones, and the same
-- result columns, so the old code calls it unchanged and never receives the new outcomes (it never sends a key). Apply this migration BEFORE
-- deploying the new code. The new code against a database WITHOUT this migration gets PGRST202 / 42883 and answers 503 "try again" (nothing charged).
--
-- Rollback (forward recovery, no data loss): supabase/rollback/20261023_03_rollback.sql. Read docs/MIGRATION_03_REVIEW_PACKAGE.md first.
--
-- Run once in the Supabase SQL editor of the Resume project. Idempotent. One transaction: it either applies completely or not at all.

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
