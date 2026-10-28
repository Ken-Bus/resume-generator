-- Migration 05: one included AI Polish per paid Analyze, and the data needed for the 96-hour completion period. ADDITIVE and backward compatible.
--
-- STATUS: PREPARED FOR REVIEW. NOT APPLIED to production. Do not run until the owner has approved it (see docs/MIGRATION_05_REVIEW_PACKAGE.md).
--
-- Policy (owner-approved):
--   * Analyze costs 1 generation and carries ONE included AI Polish. The included Polish never expires.
--   * A Polish uses the included Polish only when it would otherwise have been charged (a validated, meaningful result is committed). A failed,
--     unchanged or insignificant result is released exactly as today and never touches the included Polish.
--   * Without an included Polish, a meaningful Polish uses 1 generation, exactly as today.
--   * When a code has no generations left AND no unused included Polish, it enters a completion period (default 96 hours from the last benefit used)
--     in which the customer may still sign in, edit and download. The period grants NO AI of any kind.
--
-- What this migration changes (nothing is dropped, no balance or committed row is touched):
--   1. license_reservations gets three nullable columns: kind ('analyze' | 'polish', set once, when a step is first committed), included_polish_by
--      (on an Analyze: the Polish that used its included Polish; empty = still available) and included_from (on a Polish reservation: the Analyze it
--      will use). A partial UNIQUE index on included_polish_by makes "one Polish per Analyze" a database rule, not just application code.
--   2. reserve_license_use gets one optional parameter, p_allow_included (default false), and one extra result column, included_from. With the
--      default, behaviour is identical to migration 03. The old 7-argument version is dropped so exactly one version exists; callers that pass the
--      5 or 7 named arguments they pass today still resolve to it.
--   3. commit_license_use_with_result keeps its arguments and gains two result columns (included, included_from). A step WITHOUT included_from commits
--      exactly as before and additionally records kind. A step WITH included_from claims the included Polish atomically under the license row lock,
--      commits WITHOUT lowering the balance, and stores the same encrypted recovery copy. If the included Polish is already gone it returns
--      'included_gone' and writes nothing (the application then charges nothing).
--   4. license_access_status(code[, hours]) is a READ-ONLY function that tells the application whether a code is 'active' (generations left or an unused
--      included Polish), in its 'completion' period (with the end time), or 'ended'. It adds no table, no column and stores nothing about the customer.
--
-- Compatibility with code already deployed:
--   * The published build (0a1a014) calls reserve_license_use with 5 named arguments and commit_license_use with 1. Both keep working unchanged
--     (the first through the new defaults); extra result columns are ignored by it. It never asks for an included Polish, so none is ever used.
--   * The release candidate (60073993) calls reserve_license_use with 7 named arguments and commit_license_use_with_result with 7; both keep working.
--   * Apply this migration BEFORE deploying any build that sends p_allow_included. A new build against a database WITHOUT it fails safely (503, nothing charged).
--
-- Existing Analyze steps (committed before this migration) have no kind and therefore carry no included Polish: there is no retroactive credit.
--
-- Rollback: supabase/rollback/20261027_05_rollback.sql (forward recovery, nothing a customer paid for changes). Read the review package first.
--
-- Run once in the Supabase SQL editor of the Resume project, after the pre-checks. Idempotent. One transaction: it applies completely or not at all.

begin;

alter table license_reservations add column if not exists kind text check (kind in ('analyze', 'polish'));
alter table license_reservations add column if not exists included_polish_by uuid references license_reservations(id);
alter table license_reservations add column if not exists included_from uuid references license_reservations(id);

-- One included Polish per Analyze, enforced by the database.
create unique index if not exists license_reservations_included_polish_by_uq on license_reservations (included_polish_by) where included_polish_by is not null;
-- Finds a code's unused included Polishes without scanning its whole history.
create index if not exists license_reservations_included_open_idx on license_reservations (code, committed_at) where status = 'committed' and kind = 'analyze' and included_polish_by is null;
create index if not exists license_reservations_included_from_idx on license_reservations (included_from) where included_from is not null;

-- Exactly one reserve_license_use must exist afterwards (the old 7-argument one is replaced by the 8-argument one below).
drop function if exists reserve_license_use(text, integer, integer, integer, integer, text, text);

create or replace function reserve_license_use(
  p_code text,
  p_lease_seconds integer default 45,
  p_fail_window_seconds integer default 900,
  p_fail_window_max integer default 6,
  p_fail_day_max integer default 30,
  p_request_key text default null,
  p_input_hash text default null,
  p_allow_included boolean default false)
returns table(outcome text, reservation_id uuid, remaining integer, maximum integer, retry_after_seconds integer, included_from uuid)
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
  v_free uuid := null;
begin
  -- The row lock serialises every reserve/commit for this code, so counting and inserting
  -- below cannot interleave with another request for the same code.
  select * into lic from licenses l where l.code = p_code for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::integer, null::integer, null::integer, null::uuid;
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
          return query select 'key_conflict'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer, prior.included_from;
        else
          return query select 'replay_busy'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer, prior.included_from;
        end if;
      elsif prior.committed_at <= now() - interval '24 hours' then
        return query select 'key_expired'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer, prior.included_from;
      elsif prior.input_hash is distinct from p_input_hash then
        return query select 'key_conflict'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer, prior.included_from;
      else
        if prior.redelivering_until is not null and prior.redelivering_until <= now() then
          -- a re-delivery that started and never finished (the worker died): note it so it is not held against the customer
          update license_reservations r set redelivery_lapses = r.redelivery_lapses + 1, redelivering_until = null
           where r.id = prior.id returning * into prior;
        end if;
        if prior.redelivering_until is not null then
          return query select 'replay_busy'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer, prior.included_from;
        elsif prior.redelivery_count - least(prior.redelivery_lapses, 2) >= 3 then
          return query select 'replay_limit'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer, prior.included_from;
        else
          update license_reservations r
             set redelivery_count = r.redelivery_count + 1, redelivering_until = now() + make_interval(secs => greatest(lease, 60))
           where r.id = prior.id;
          return query select 'replay'::text, prior.id, lic.uses_remaining, lic.max_uses, null::integer, prior.included_from;
        end if;
      end if;
      return;
    end if;
  end if;

  -- Included AI Polish (migration 05). Only a caller that asks for it (p_allow_included, i.e. AI Polish) can use it, and only for a paid Analyze of THIS
  -- code that has not given its included Polish yet and is not already held by a live reservation. The oldest such Analyze is used first. Nothing is
  -- changed here: the credit is claimed only when the Polish is committed (commit_license_use_with_result).
  if p_allow_included then
    select a.id into v_free
      from license_reservations a
     where a.code = p_code and a.status = 'committed' and a.kind = 'analyze' and a.included_polish_by is null
       and not exists (select 1 from license_reservations h where h.included_from = a.id and h.status = 'reserved' and h.expires_at > now())
     order by a.committed_at asc, a.id asc
     limit 1;
  end if;

  if v_free is null and lic.uses_remaining <= 0 then
    return query select 'exhausted'::text, null::uuid, lic.uses_remaining, lic.max_uses, null::integer, null::uuid;
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
    return query select 'throttled'::text, null::uuid, lic.uses_remaining, lic.max_uses, least(retry, 86400), null::uuid;
    return;
  end if;

  select count(*) into active
    from license_reservations r
   where r.code = p_code and r.status = 'reserved' and r.expires_at > now();

  if v_free is null and lic.uses_remaining - active <= 0 then
    return query select 'busy'::text, null::uuid, lic.uses_remaining, lic.max_uses, null::integer, null::uuid;
  else
    insert into license_reservations (code, expires_at, request_key, input_hash, included_from)
    values (p_code, now() + make_interval(secs => lease), p_request_key, p_input_hash, v_free)
    returning id into new_id;
    return query select 'reserved'::text, new_id, lic.uses_remaining, lic.max_uses, null::integer, v_free;
  end if;
end;
$$;

-- Commit the generation (or the included Polish) AND store the encrypted copy, atomically.
-- outcome: committed | already_committed | released | expired | exhausted | not_found | included_gone.
-- included = this step used (or had used) an included Polish and did NOT take a generation.
drop function if exists commit_license_use_with_result(uuid, text, text, text, text, text, integer);
create or replace function commit_license_use_with_result(
  p_reservation_id uuid,
  p_fn text,
  p_kid text,
  p_salt text,
  p_iv text,
  p_ct text,
  p_keep_seconds integer default 86400)
returns table(outcome text, remaining integer, maximum integer, result_saved boolean, expires_at timestamptz, included boolean, included_from uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  res license_reservations%rowtype;
  lic licenses%rowtype;
  v_code text;
  v_from uuid;
  n integer;
  keep integer := least(greatest(coalesce(p_keep_seconds, 86400), 60), 86400);
  v_expires timestamptz;
begin
  if p_fn not in ('analyze', 'polish') or coalesce(length(p_ct), 0) = 0 or length(p_ct) > 400000
     or coalesce(length(p_kid), 0) = 0 or coalesce(length(p_salt), 0) = 0 or coalesce(length(p_iv), 0) = 0 then
    raise exception 'invalid recovery copy' using errcode = '22023';                        -- aborts the whole call: nothing is charged
  end if;
  select r.code, r.included_from into v_code, v_from from license_reservations r where r.id = p_reservation_id;

  if v_from is null then
    -- An ordinary paid step: the existing, tested commit, in THIS transaction. kind is recorded once, on the first commit only.
    select * into c from commit_license_use(p_reservation_id);
    if c.outcome = 'committed' then
      update license_reservations r set kind = p_fn where r.id = p_reservation_id and r.kind is null;
    end if;
    if c.outcome in ('committed', 'already_committed') then
      insert into result_recovery (reservation_id, code, fn, kid, salt, iv, ct, expires_at)
      values (p_reservation_id, v_code, p_fn, p_kid, p_salt, p_iv, p_ct, now() + make_interval(secs => keep))
      on conflict (reservation_id) do nothing;                                                -- one copy per paid step; the first one is kept
      select rr.expires_at into v_expires from result_recovery rr where rr.reservation_id = p_reservation_id;
      return query select c.outcome, c.remaining, c.maximum, (v_expires is not null and v_expires > now()), v_expires, false, null::uuid;
    else
      return query select c.outcome, c.remaining, c.maximum, false, null::timestamptz, false, null::uuid;
    end if;
    return;
  end if;

  -- A step that uses an included Polish. Only an AI Polish can.
  if p_fn <> 'polish' then
    raise exception 'only a polish can use an included polish' using errcode = '22023';
  end if;
  -- Lock order is always license row first, then reservation row (as commit_license_use).
  select * into lic from licenses l where l.code = v_code for update;
  select * into res from license_reservations r where r.id = p_reservation_id for update;

  if res.status = 'released' then
    return query select 'released'::text, lic.uses_remaining, lic.max_uses, false, null::timestamptz, false, v_from;
    return;
  end if;

  if res.status <> 'committed' then
    -- The one-time claim. It succeeds for exactly one Polish: the Analyze must belong to this code, be paid, and still be unclaimed.
    update license_reservations a set included_polish_by = p_reservation_id
     where a.id = v_from and a.code = v_code and a.status = 'committed' and a.kind = 'analyze' and a.included_polish_by is null;
    get diagnostics n = row_count;
    if n = 0 then
      return query select 'included_gone'::text, lic.uses_remaining, lic.max_uses, false, null::timestamptz, false, v_from;
      return;
    end if;
    -- Committed WITHOUT lowering the balance. last_used_at moves because a benefit was used.
    update license_reservations r set status = 'committed', committed_at = now(), kind = 'polish' where r.id = p_reservation_id;
    update licenses l set last_used_at = now() where l.code = v_code;
    res.status := 'committed_now';
  end if;

  insert into result_recovery (reservation_id, code, fn, kid, salt, iv, ct, expires_at)
  values (p_reservation_id, v_code, p_fn, p_kid, p_salt, p_iv, p_ct, now() + make_interval(secs => keep))
  on conflict (reservation_id) do nothing;
  select rr.expires_at into v_expires from result_recovery rr where rr.reservation_id = p_reservation_id;
  return query select (case when res.status = 'committed_now' then 'committed' else 'already_committed' end)::text,
                      lic.uses_remaining, lic.max_uses, (v_expires is not null and v_expires > now()), v_expires, true, v_from;
end;
$$;

-- Access state of a code. READ-ONLY; stores nothing.
--   active     : generations left, or at least one unused included Polish (no end date: an unused included Polish never expires)
--   completion : no AI left; the customer may still sign in, edit, switch templates and download until access_until (default 96 hours after the
--                last benefit was used). This grants NO generation and NO included Polish.
--   ended      : no AI left and the completion period is over (or the code never used a benefit)
--   not_found  : no such code
-- The period starts at the newest committed paid step of the code (its last benefit); for a code with no committed step it falls back to
-- licenses.last_used_at (set by every commit), and without either it is 'ended'. Nothing needs to be written when the last benefit is used.
create or replace function license_access_status(p_code text, p_completion_hours integer default 96)
returns table(code_exists boolean, uses_remaining integer, max_uses integer, included_available integer, access_state text, access_until timestamptz, last_benefit_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  lic licenses%rowtype;
  hrs integer := least(greatest(coalesce(p_completion_hours, 96), 1), 720);
  inc integer;
  last_at timestamptz;
begin
  select * into lic from licenses l where l.code = p_code;
  if not found then
    return query select false, null::integer, null::integer, null::integer, 'not_found'::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  select count(*)::integer into inc from license_reservations a
   where a.code = p_code and a.status = 'committed' and a.kind = 'analyze' and a.included_polish_by is null;
  if lic.uses_remaining > 0 or inc > 0 then
    return query select true, lic.uses_remaining, lic.max_uses, inc, 'active'::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  select max(r.committed_at) into last_at from license_reservations r where r.code = p_code and r.status = 'committed';
  last_at := coalesce(last_at, lic.last_used_at);
  if last_at is not null and now() < last_at + make_interval(hours => hrs) then
    return query select true, lic.uses_remaining, lic.max_uses, inc, 'completion'::text, last_at + make_interval(hours => hrs), last_at;
  else
    return query select true, lic.uses_remaining, lic.max_uses, inc, 'ended'::text, case when last_at is null then null::timestamptz else last_at + make_interval(hours => hrs) end, last_at;
  end if;
end;
$$;

-- Server-only, like every other billing function.
revoke execute on function reserve_license_use(text, integer, integer, integer, integer, text, text, boolean) from public, anon, authenticated;
revoke execute on function commit_license_use_with_result(uuid, text, text, text, text, text, integer)       from public, anon, authenticated;
revoke execute on function license_access_status(text, integer)                                              from public, anon, authenticated;
grant  execute on function reserve_license_use(text, integer, integer, integer, integer, text, text, boolean) to service_role;
grant  execute on function commit_license_use_with_result(uuid, text, text, text, text, text, integer)       to service_role;
grant  execute on function license_access_status(text, integer)                                              to service_role;

commit;
