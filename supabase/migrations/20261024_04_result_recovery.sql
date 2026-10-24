-- Migration 04: temporary encrypted recovery copy of a COMPLETED, CHARGED Analyze or AI Polish result. ADDITIVE.
--
-- Purpose: a customer whose reply is lost (power, network, browser closed) can get the EXACT completed result back for up to 24 hours by entering the
-- access code they already have, without spending another generation and without resubmitting the resume. It is not a library, not an account
-- feature and not long-term storage: every row expires 24 hours after it is written at the latest, and an expired row can never be returned
-- even if the cleanup has not run yet.
--
-- What is stored: ONLY the finished result, ENCRYPTED in the application (AES-256-GCM, key held by the server, never in this database), plus the
-- ids and times needed to find and expire it. Never the pasted resume, the job description, the prompt, or any access code of its own
-- (the code column links the row to the license, exactly as license_reservations does).
--
-- Atomicity: commit_license_use_with_result runs the EXISTING commit_license_use and the insert of the encrypted copy in ONE transaction. If either
-- fails, neither happens: a generation is never charged without its recovery copy, and a copy never exists for a charge that did not happen.
--
-- Compatibility: nothing existing is changed. The deployed application (which calls commit_license_use) keeps working unchanged. The new application
-- calls the new function; against a database without this migration it REFUSES to charge ("try again") rather than charge without a copy.
--
-- Rollback: supabase/rollback/20261024_04_rollback.sql removes the functions and the table. At most 24 hours of recovery copies disappear;
-- licenses, balances and every reservation row (the permanent charge record) are untouched.
--
-- Run once in the Supabase SQL editor of the Resume project. Idempotent. One transaction.

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
