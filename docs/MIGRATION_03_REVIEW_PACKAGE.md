# Migration 03 review package: durable duplicate-charge protection

**Status: prepared for owner review. NOT applied to production or to any Supabase project.** Everything below was tested only against disposable local PostgreSQL 16.

| File | Lines | SHA-256 |
|---|---|---|
| `supabase/migrations/20261023_03_request_idempotency.sql` (the migration) | 184 | `08fcccc0b25b53e10b88caf4c47e1a60f469f4075da3e8b8ea3f097dab62b863` |
| `supabase/rollback/20261023_03_rollback.sql` (the rollback, never run automatically) | 121 | `919618ec1f32704c4988af5705dcd7ef663216b4b3ce579c4799297b54063561` |

Verify the files you review are the ones you run: `shasum -a 256 <file>` must print the hash above. The same SQL is mirrored at the end of `supabase/schema.sql` for fresh installs.

## 1. What it does in one paragraph
Today, if a charged Analyze or AI Polish reply is lost and the browser retries on a different (or restarted) server instance, the retry looks like a brand-new request and can charge a second generation. The migration lets the database remember, for each paid step, two hashes: of the page's request id and of the request's input. A retry with the same id and the same input is recognised under the license row lock and answered `replay`: no reservation, no charge. The server then re-delivers the result by running the AI once more (nothing of the customer's text is stored). Re-delivery is limited to 3 per paid step, one at a time, and a failed re-delivery gives its turn back.

## 2. Exactly what changes in the database
| Object | Change |
|---|---|
| `license_reservations` | 4 new nullable/defaulted columns: `request_key text`, `input_hash text`, `redelivery_count integer not null default 0`, `redelivering_until timestamptz`; 1 new partial index on `(code, request_key)` |
| `reserve_license_use` | The 5-argument version is dropped and replaced by a 7-argument version. The first five parameters and all result columns are unchanged; `p_request_key` and `p_input_hash` default to null. Logic added: when a key is supplied and a committed row for the same code, key and input exists (committed within 60 minutes), return `replay`, `replay_busy` or `replay_limit` instead of reserving. With no key it behaves exactly as before |
| `finish_redelivery(uuid, boolean)` | New. Frees a re-delivery slot; gives the attempt back when it failed |
| Privileges | Both functions: `revoke ... from public, anon, authenticated`, `grant ... to service_role`, `security definer`, `search_path = public` |
| Not touched | `licenses` (no row, column or policy), all other functions, Row Level Security, existing reservation rows |

The whole migration runs in one transaction (`begin; ... commit;`) and is idempotent (every statement is `if not exists` / `drop if exists` / `create or replace`).

## 3. Compatibility with the application in production today
"Production today" is the code before the reservation work (`consume-generation`, `verify-license`, `check-code-supply`, the Google Apps Script) and/or the post-migration-01 code (5-argument calls). Both were exercised against four database states: A = today's live snapshot, B = + migration 01, C = + 02, D = + 03 (`tests/db/migration03-review.test.js`).

| Check | Result |
|---|---|
| The ORIGINAL production handlers (`verify-license`, `consume-generation`, from git commit `d1abe1d^`) run unchanged: valid code, unknown code, consume, exhaust, repeat | Identical answers in A, B, C and D |
| Post-01 calls: 5-argument reserve, reserve with defaults, commit (twice), tailor authorize, refund, release, unknown code | Identical results in B and D |
| Apps Script / supply operations: select, `update licenses set assigned...`, `insert into licenses` | Work in D; applying all three migrations changes no license row (fingerprint equal) |
| New branch code against a database WITHOUT migration 03 | A request carrying a request id answers a calm 503 "try again", charges nothing, makes no AI call (`durable-idempotency.test.js`); a request without an id works as before |
| Old page (no request ids) against the new code and database | Unchanged behaviour, no key stored |

Therefore the deployment order is safe in either direction for customers, and the only unsafe order (code first) merely shows "try again" until the SQL is applied.

## 4. Permissions
Every function in the `public` schema, including the two new-surface ones, is executable by `service_role` only; `anon` and `authenticated` cannot run any of them or touch `license_reservations` (RLS on, no policies). Both functions are `security definer` with a pinned `search_path`. Verified by catalog query for all functions, not a sample.

## 5. Concurrency, retries, restarts (real PostgreSQL)
| Scenario | Evidence |
|---|---|
| Migration applied twice while 8 connections run reserve/commit traffic | No request errored; generations consumed equals commits (none lost or doubled); nothing left held |
| Six simultaneous retries of one paid step | Exactly one `replay`, five `replay_busy`; one charge in total |
| Five simultaneous retries across three cold "instances" (separate handlers and pools) | One re-delivery runs, four are told to wait; no extra charge |
| Reply lost, retry on a cold instance or after a restart (Analyze and Polish) | One charge; result re-delivered; tailoring token still valid |
| Worker died after reserving (never committed) | Not treated as paid; after the lease lapses the same key reserves normally; after commit it replays |
| Edited input, other request id, other code | A new step; never a stale or foreign result |
| Fourth re-delivery; failed re-delivery | Clear message, no AI call, no charge; a failed one gives its turn back |
| Re-delivered step on an exhausted code | Still re-delivered (the customer paid for it) |

## 6. Rollback
`supabase/rollback/20261023_03_rollback.sql` (hash above), one transaction, idempotent: drops `finish_redelivery` and the 7-argument function and recreates the 5-argument function exactly as migration 01 defined it, with the same server-only privileges. It does not touch balances or any committed or released row, and keeps the four new columns (inert; keeping them means rolling forward again needs no data work).
Tested: balances and committed rows identical before and after (twice); the previous deployment's 5-argument call works afterwards; the new code's call fails closed; migration 03 re-applies cleanly and a key written before the rollback is honoured again.
Order if ever needed: redeploy the previous Netlify build first, then run the rollback.

## 7. Deployment plan (owner steps; I have not performed any of them)
Prerequisite: the owner reviews this document and the SQL, and approves.
1. **Backup.** Supabase dashboard: Database, Backups: confirm a recent backup exists or take one. Export `licenses` and `license_reservations` as CSV and store them privately.
2. **Check the starting state** in the SQL editor: `select proname, pronargs from pg_proc where proname in ('reserve_license_use','commit_license_use','release_license_use','consume_tailor_use','refund_tailor_use') order by 1;` Expect migration 01 present (`reserve_license_use` with 5 arguments). If migration 01 is not present, stop: apply 01 and 02 first per `SETUP.md`.
3. **Apply** the migration file in the SQL editor (paste the file; it is one transaction).
4. **Verify** (all in the SQL editor):
   - `select proname, pronargs from pg_proc where proname in ('reserve_license_use','finish_redelivery') order by 1;` expects exactly `finish_redelivery 2` and `reserve_license_use 7`.
   - `select count(*) from licenses;` and the customers-only fingerprint you recorded in step 2 are unchanged.
   - `select has_function_privilege('anon','public.finish_redelivery(uuid,boolean)','execute');` expects false (also `authenticated`); `service_role` true.
   - If the API reports a function "not found", run `notify pgrst, 'reload schema';`.
5. **Smoke-test the currently deployed site** with your personal code: verify-license and one normal generation still work and the counter drops by one.
6. **Deploy the feature branch** by your normal process (merge and publish are yours to approve).
7. **Smoke-test the new build**: the polish endpoint reports the expected guard version; one generation on a personal code; then in the SQL editor `select request_key is not null as keyed from license_reservations order by created_at desc limit 1;` expects true.
8. **Watch** the Netlify function logs for 24 hours for `reserve_license_use is missing` (step 3 not done) or repeated 5xx.

Abort and roll back if step 4 or 5 fails, or the counter drops by more than one for one generation. Rollback = redeploy the previous Netlify build (instant) and, only if the SQL itself misbehaves, run the rollback file.

## 8. Customer-impact risks
- While step 3 runs, the function is replaced inside one transaction; a request arriving in that instant waits for the lock rather than failing (shown under load in section 5).
- A re-delivery costs one extra AI call (Flex & Grace's cost, not the customer's), at most 3 per paid step; the re-delivered wording may differ slightly from the lost one.
- A retry later than 60 minutes after the charge is a new step and is charged normally; the page keeps one request id only for the same unfinished step.
- If a step is re-delivered 3 times without success the customer is told to message us with their code; nothing more is charged.
- Not verified against the real Supabase service: PostgREST schema cache timing (step 4 note), real latency, real connection limits. These are why the smoke tests in steps 5 and 7 exist.

## 9. Owner approvals required
1. Approve applying migration 03 to the production Supabase project (steps 1 to 5).
2. Approve merging the feature branch and publishing it (step 6).
3. Authorize one paid generation on a personal code for the smoke test (step 7).

## Appendix A: the migration, verbatim

```sql
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
```

## Appendix B: the rollback, verbatim

```sql
-- ROLLBACK for migration 03 (20261023_03_request_idempotency.sql). NOT a migration: it lives outside supabase/migrations on purpose and is
-- never run automatically. Use it only if the owner decides to remove the durable-idempotency feature after applying migration 03.
--
-- What it does (one transaction, idempotent):
--   * removes finish_redelivery and the 7-argument reserve_license_use;
--   * recreates the 5-argument reserve_license_use exactly as migration 01 defined it, with the same server-only privileges.
-- What it deliberately does NOT do:
--   * it does not touch `licenses` (balances) or any committed/released reservation row: nothing a customer paid for is changed;
--   * it keeps the four new columns on license_reservations (request_key, input_hash, redelivery_count, redelivering_until). They are inert
--     without the new function, cost nothing, and keeping them means re-applying migration 03 later needs no data migration.
-- Order when rolling back: redeploy the previous Netlify build FIRST (the new build sends request keys and would answer "try again" against
-- the rolled-back database; it never charges), then run this file.

begin;

drop function if exists finish_redelivery(uuid, boolean);
drop function if exists reserve_license_use(text, integer, integer, integer, integer, text, text);

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

revoke execute on function reserve_license_use(text, integer, integer, integer, integer) from public, anon, authenticated;
grant  execute on function reserve_license_use(text, integer, integer, integer, integer) to service_role;

commit;
```
