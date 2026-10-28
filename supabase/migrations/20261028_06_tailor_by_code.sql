-- Migration 06: tailoring runs are found from the access code, so they survive a closed browser, a break and a new day. ADDITIVE and backward compatible.
--
-- STATUS: PREPARED FOR REVIEW. NOT APPLIED to production. Do not run until the owner has approved it.
--
-- Policy (owner-approved):
--   * The existing limit stays: up to 5 Tailor runs per qualifying paid AI step (an Analyze, or a charged Polish). An included Polish adds none: it shares
--     its parent Analyze's five.
--   * Tailor never uses a generation. It no longer expires after two hours: the runs are kept in the database (license_reservations.tailor_count, unchanged).
--   * It is allowed while the code is active and during the 96-hour completion period, and refused after access has ended. The access state is decided
--     by license_access_status (migration 05) in the application, exactly as export-resume does.
--
-- What this migration adds (nothing is dropped, altered or backfilled; no balance, no committed row and no existing function is touched):
--   1. consume_tailor_for_code(code, max): in ONE transaction, under the license row lock (so parallel requests of one code run one after another),
--      picks the oldest committed paid step of THAT code that still has a run left and uses one. Returns the step it used, so a failed AI call can give
--      the run back to the same step with the existing refund_tailor_use. A code can never reach another code's steps.
--   2. tailor_runs_available(code, max): READ-ONLY count of the runs the code has left (5 minus the runs used, summed over its qualifying steps).
--
-- Qualifying step = status 'committed' and not an included Polish (included_from is null). That is an Analyze, a charged Polish, or a step committed
-- before migration 05 (no kind). Reserved, released and expired reservations never qualify.
--
-- Compatibility with code already deployed: the published build only calls consume_tailor_use and refund_tailor_use, which stay as they are.
-- Apply this migration BEFORE deploying the build that calls consume_tailor_for_code. A new build against a database WITHOUT it keeps the earlier,
-- token-based tailoring (and, with no token, answers "temporarily unavailable" and uses nothing).
--
-- Rollback: drop the two functions (see the bottom of this file). Nothing a customer paid for changes.
--
-- Requires migration 05 (included_from, license_access_status). Run once in the Supabase SQL editor of the Resume project. Idempotent. One transaction.

begin;

do $$
begin
  if to_regprocedure('public.license_access_status(text,integer)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'license_reservations' and column_name = 'included_from')
     or to_regprocedure('public.refund_tailor_use(uuid,boolean,integer)') is null then
    raise exception 'Migration 06 needs migrations 03 to 05 applied first. Nothing was changed.';
  end if;
end $$;

create or replace function consume_tailor_for_code(p_code text, p_max integer)
returns table(outcome text, reservation_id uuid, used integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  lic licenses%rowtype;
  rid uuid;
  n integer;
begin
  -- One request of a code at a time: two parallel runs can never pick the same last run.
  select * into lic from licenses l where l.code = p_code for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;

  select r.id into rid
    from license_reservations r
   where r.code = p_code and r.status = 'committed' and r.included_from is null and r.tailor_count < p_max
   order by coalesce(r.committed_at, r.created_at), r.id
   limit 1;

  if rid is null then
    if exists (select 1 from license_reservations r where r.code = p_code and r.status = 'committed' and r.included_from is null) then
      return query select 'limit'::text, null::uuid, null::integer;       -- every qualifying step has used its runs
    else
      return query select 'invalid'::text, null::uuid, null::integer;     -- no paid step yet
    end if;
    return;
  end if;

  update license_reservations r set tailor_count = r.tailor_count + 1
   where r.id = rid and r.tailor_count < p_max
  returning r.tailor_count into n;
  return query select 'ok'::text, rid, n;
end;
$$;

create or replace function tailor_runs_available(p_code text, p_max integer)
returns table(runs_available integer, paid_steps integer)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(greatest(p_max - r.tailor_count, 0)), 0)::integer, count(*)::integer
    from license_reservations r
   where r.code = p_code and r.status = 'committed' and r.included_from is null;
$$;

-- Server-only, like every other billing function.
revoke execute on function consume_tailor_for_code(text, integer) from public, anon, authenticated;
revoke execute on function tailor_runs_available(text, integer)   from public, anon, authenticated;
grant  execute on function consume_tailor_for_code(text, integer) to service_role;
grant  execute on function tailor_runs_available(text, integer)   to service_role;

commit;

-- Rollback (only if ever needed; the application then uses the token path again):
--   drop function if exists consume_tailor_for_code(text, integer);
--   drop function if exists tailor_runs_available(text, integer);
