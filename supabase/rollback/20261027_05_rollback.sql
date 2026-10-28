-- ROLLBACK for migration 05 (20261027_05_included_polish.sql). NOT a migration: it lives outside supabase/migrations on purpose and is never run
-- automatically. Use it only if the owner decides to remove the included-Polish feature after applying migration 05.
--
-- It returns the database to the state after migration 04 (state "E"):
--   * removes license_access_status and the 8-argument reserve_license_use;
--   * recreates the 7-argument reserve_license_use exactly as migration 03 defined it, and commit_license_use_with_result exactly as migration 04 defined it
--     (same arguments, same result columns, same server-only privileges). The function text below is copied from those two files.
-- What it deliberately does NOT do:
--   * it does not touch `licenses` (balances) or any reservation row: every paid Analyze and Polish, and every included Polish already used, stays on record;
--   * it keeps the three new columns and their indexes on license_reservations (kind, included_polish_by, included_from). They are inert without the new
--     functions, cost nothing, and keeping them means re-applying migration 05 later needs no data migration and loses no used or unused included Polish.
-- Consequence to know: after a rollback an UNUSED included Polish simply cannot be used (the old functions do not know about it). It is not lost: re-applying
-- migration 05 makes it usable again. A Polish that already used its included Polish stays committed and keeps its recovery copy.
-- Order when rolling back: redeploy the previous Netlify build FIRST (a build that sends p_allow_included would answer "try again" against the rolled-back
-- database; it never charges), then run this file.

begin;

drop function if exists license_access_status(text, integer);
drop function if exists commit_license_use_with_result(uuid, text, text, text, text, text, integer);
drop function if exists reserve_license_use(text, integer, integer, integer, integer, text, text, boolean);

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

revoke execute on function reserve_license_use(text, integer, integer, integer, integer, text, text)       from public, anon, authenticated;
revoke execute on function commit_license_use_with_result(uuid, text, text, text, text, text, integer)       from public, anon, authenticated;
grant  execute on function reserve_license_use(text, integer, integer, integer, integer, text, text)       to service_role;
grant  execute on function commit_license_use_with_result(uuid, text, text, text, text, text, integer)       to service_role;

commit;
