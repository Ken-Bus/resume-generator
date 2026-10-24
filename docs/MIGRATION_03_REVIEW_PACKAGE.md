# Migration 03 review package: durable duplicate-charge protection (revision 2)

**Status: prepared for owner review. NOT applied to production or to any Supabase project.** All evidence below is from disposable local PostgreSQL 16 and mocked AI. Nothing here was verified against live Supabase, live Netlify or the real Anthropic API.

Revision 2 resolves the five findings of the independent review of revision 1 (commit `eb5323c`). Section 12 lists each finding and its disposition.

| File | Lines | SHA-256 |
|---|---|---|
| `supabase/migrations/20261023_03_request_idempotency.sql` | 238 | `e64025d880004f2838b6c36f81b21fefba95805e68f31fa79d9517d3a4d93196` |
| `supabase/rollback/20261023_03_rollback.sql` (never run automatically) | 122 | `b1516e0369c25b304a3132dceccf4780de34db61adecfe27a667e9c1de62afe1` |
| `docs/MIGRATION_03_PREFLIGHT.sql` (read-only checks, section 7) | 53 | `ebab14078656eb476805c0a45a4b0d575157fdcb0b11bd9e1f16db63783360ff` |

Check the file you are about to run against the hash: `shasum -a 256 <file>`. The migration is mirrored at the end of `supabase/schema.sql` for fresh installs.

## 1. What it does
The page sends one **request id** per logical step and reuses it only to retry that same step. The database remembers, on the reservation row, two keyed hashes: of the id (`request_key`) and of the step's input (`input_hash`). When a paid step is requested, `reserve_license_use` looks for the id under the license row lock and decides. **A retry can never become a second charge; only a new id (a deliberate new operation) can.**

| Same code and request id found as... | Outcome | Charged? | What the customer sees |
|---|---|---|---|
| nothing | ordinary reservation | on commit only (as before) | normal flow |
| committed, same input, within 24 h, no recovery running | `replay` | **no** | result recovered (see section 4) |
| committed, same input, recovery already running | `replay_busy` | no | "another generation is in progress, wait a moment" |
| committed, same input, recovery limit reached | `replay_limit` | no | plain message + support reference |
| committed, **different input** | `key_conflict` | **no** | "your resume has changed since an earlier step that may already have been counted; check the counter, press again to start a new one" |
| committed, older than 24 h | `key_expired` | **no** | "more than a day old, cannot be recovered here; press again to start a new one" |
| still running, same input | `replay_busy` | no | wait a moment |
| still running, **different input** | `key_conflict` | no | as above |
| released / expired / free (never paid) | ignored: ordinary new reservation | on commit only | normal flow |

Both refusals (`key_conflict`, `key_expired`) and the limit make the page drop the spent id, so the customer's **next deliberate press** is a fresh operation. Nothing is retried automatically.

## 2. Finding 1: request-id reuse
Revision 1 matched on key **and** input, so a reused id with edited input fell through to a new chargeable reservation. Revision 2 refuses it (`key_conflict`). The same rule covers a stale browser (same id, same input: recovered free, or `key_expired` after 24 h), overlapping operations (one runs, the other waits or is refused), refreshes and restarts (the state is in the database, not in memory). The in-memory fast path was also fixed: its key now includes the input, so an instance can no longer answer edited input with an earlier input's result. A customer can still edit and re-polish repeatedly: each deliberate press with a new id is a normal operation.

## 3. Finding 2: retention policy (explicit)
| Item | Kept | Why |
|---|---|---|
| Recovery window (replay allowed) | **24 hours** after the commit | covers a reopened tab or a next-morning retry; beyond it a re-run is no longer "the same step" in the customer's mind |
| `request_key` on a **paid** (committed) row | as long as the committed row (the permanent accounting record that already exists) | so a stale id is **refused forever instead of being charged**; no new rows, ~64 bytes per paid step |
| `input_hash` | erased **24 hours** after the step: lazily by `reserve_license_use` for that code, and for every code by `purge_idempotency_hashes()` (daily, called by `check-code-supply`) | data minimisation: it is derived from the resume text |
| `request_key` on unpaid rows (released, expired) | erased after 24 h by the purge; the rows themselves are deleted after 30 days (existing rule) | they have no use after the window |
| Raw resumes, AI output, contact details | **never stored** | no approval for such storage |

Both hashes are HMAC-SHA256 with the server's existing `TAILOR_TOKEN_SECRET` (plain SHA-256 if that secret is missing, consistently on every instance), so they cannot be matched to a guessed resume or id without the secret. Residual limitations, stated plainly: (a) an input hash may linger up to one day plus the time to the next daily run; (b) rotating `TAILOR_TOKEN_SECRET` makes earlier hashes unrecognisable, so a step paid before the rotation could not be matched afterwards: rotate only when no customer is mid-step; (c) protection against a *repeated id* is permanent, but recovery of the *result* is 24 hours; (d) a customer who deliberately starts a new operation with a new id can be charged again, by design.

## 4. Finding 3: paid-result recovery without storing results
**Exact recovery would require storing the AI output, which needs your approval and is not implemented.** What is implemented:
- **Same server instance within 5 minutes:** the exact original answer is returned from memory, labelled "restored exactly as it was". No AI call.
- **Any other case within 24 hours (another instance, a restart, a reopened tab):** the database proves the step was paid; the server runs the AI **once more** for the same resume and labels the result **"a fresh version ... the wording may differ from the first one. No additional generation was used."** It is never presented as the original.
- **Cost control:** at most 3 finished recoveries per paid step (abandoned leases forgiven, at most 2, so at most 5 AI calls per step in the worst case), one at a time (60-second lease), none automatic; a refused or failed recovery makes no charge. Each recovery is one ordinary AI call (the same size as the original).
- **Outage during recovery:** the attempt is given back (it does not count toward the limit); the customer is told the earlier step was counted, nothing more is charged, the AI is busy or unavailable, and to try again; the **same id is kept** so the paid step stays recoverable.
- **Customer edits and the original input:** a recovery only runs for the same input; edited input is refused (section 2). Restore still returns the customer's own wording.
- **Owner decision, optional:** storing the AI output (even encrypted) for 24 hours would give exact recovery and save the extra AI calls, at the price of holding customer resume content in the database. Not done; say so if you want a proposal.

## 5. Finding 4: customers are not abandoned
| Situation | What happens |
|---|---|
| Recovery limit reached | `recovery_limit`: plain message, **non-secret support reference** `R-XXXXXXXX` (first 8 characters of the paid step's id; identifies a step for the owner and grants nothing), no access code or resume asked for; nothing more charged; the page offers "press again to start a new one" |
| Edited after a possibly-paid step | `request_conflict`: explained, reference shown, counter refreshed, next press is a new operation |
| Id older than 24 h | `request_expired`: explained, new operation on the next press |
| Browser closed mid-recovery (lease abandoned) | after 60 s the lease lapses; the lapse is forgiven (up to 2) so the customer still gets their attempts |
| Recovery fails (AI outage, timeout, unusable answer) | attempt given back; honest message; same id kept |
| Balance | always the database's: the page shows `usesRemaining` from every response and re-reads the counter after a refusal |

Support runbook (owner-run, read-only until you decide): `select id, status, committed_at, redelivery_count, redelivery_lapses from license_reservations where id::text like lower('XXXXXXXX') || '%';` (use the 8 characters after `R-`). If the customer never received a result, you may restore one generation to that code by hand (`update licenses set uses_remaining = least(uses_remaining + 1, max_uses) where code = (select code from license_reservations where id::text like lower('XXXXXXXX') || '%');`). That is a production data change and is your decision each time.

## 6. Compatibility matrix (real local PostgreSQL; the previous application is run from git history, unmodified)
`P0` = the original production code before reservation accounting (`d1abe1d^`); `P1` = the previous application (`b6884f3`); `N` = this branch. Database: `A` live snapshot, `B` = +01, `C` = +02, `D` = +03, `R` = D after the rollback script.

| Application | A | B | C | D | R |
|---|---|---|---|---|---|
| P0 (verify-license, consume-generation) | works | identical answers | identical | identical | n/a (needs only the original objects, untouched) |
| P1 (never sends a request id) | n/a (needs 01) | works | identical to B | identical to B | identical to B |
| N (sends request ids) | 503 "try again", no charge | 503, no charge, no AI call | 503, no charge | **works, durable** | 503, no charge, no AI call |
| N without a request id (older page) | n/a | works | works | works | works |

Tests: `tests/db/migration03-review.test.js` (P0 and permissions and load) and `tests/functions/compat-matrix.test.js` (P1 and N). **Two honest consequences:** (1) with P1 or P0 running, or after a rollback, a lost reply retried on a cold instance can still charge again: durable protection needs migration 03 **and** the new application; the compat test asserts this as a known limitation rather than hiding it. (2) An older Netlify deploy is only known to work against the database states in the table: do not assume it works with any other change.

## 7. Deployment runbook (owner steps; none performed)
**Read-only preflight** (`docs/MIGRATION_03_PREFLIGHT.sql`, hash above). It contains only `select` statements. Run it and keep the output.
1. **Identify the state.** Expected before: migration 01 (and 02) applied, `reserve_license_use` has one overload with 5 arguments, no `request_key` column. If it shows no reservation table (state A), stop: apply 01 and 02 first per `SETUP.md`.
2. **Record balances.** The preflight prints a license count, the sum of remaining generations and an `md5` fingerprint of `(code, uses_remaining, max_uses)`. Real customers use codes, so the fingerprint changes with real use; run the same query after the migration and reconcile any difference against `license_reservations` commits in between. No balance may change because of the migration itself (the migration contains no statement that touches `licenses`).
3. **Backup prerequisite.** Confirm in the Supabase dashboard that a backup / point-in-time recovery covers now, and export `licenses` and `license_reservations` to CSV. Do not continue without it.
4. **Quiet window (recommended).** Not required for correctness (tested under load) but makes reconciliation trivial.
5. **Apply** the migration file in the SQL editor. It is one transaction: it applies completely or not at all.
6. **If the editor times out or shows an error: do NOT assume it failed and do NOT re-run yet.** Run the preflight state query again (read-only). Also run the "is it still running?" query in the preflight file. Outcomes: state **D** (7-argument function, new columns) means it applied: do not re-run. State **B/C** with no running session means nothing was applied (the transaction rolled back): it is safe to run again once. A still-running session: wait for it, then re-check. The migration is idempotent, so a duplicate run is harmless, but verification comes first.
7. **Verify** with the preflight's "after" queries: exactly one `reserve_license_use` (7 args), `finish_redelivery`, `purge_idempotency_hashes`; five new columns; privileges (anon / authenticated: none; service_role: all); `license_reservations` RLS on; balances reconciled.
8. **Schema cache.** Supabase's API caches function signatures. It normally refreshes after DDL. If any call reports "could not find the function", run `notify pgrst, 'reload schema';` (it changes no data) and retry once. The old five-argument call keeps working because the new function accepts it with defaults (tested with named-argument calls, as the API makes them).
9. **Smoke-test the currently deployed site** (old application, new database): verify-license and one generation with your personal code; the counter drops by exactly one.
10. **Duplicate-charge smoke test without AI cost** (SQL editor): create a throwaway license, e.g. `insert into licenses (code, max_uses, uses_remaining, assigned) values ('FG-SMKE-TEST', 5, 5, true);` then run, in order, `select * from reserve_license_use('FG-SMKE-TEST',45,900,6,30,'smoke-key','smoke-input');` (expect `reserved`), `select * from commit_license_use('<reservation_id>');` (`committed`, balance 4), the same reserve call again (expect **`replay`**, balance still 4), `finish_redelivery('<reservation_id>', true)`, the reserve call with input `'other-input'` (expect **`key_conflict`**), then clean up with `delete from licenses where code = 'FG-SMKE-TEST';`. This proves the durable behaviour on the real database with no customer data and no AI call.
11. **Deploy the feature branch** (your merge and publish approval). Then smoke-test with your personal code: one generation (counter minus one) and `select request_key is not null from license_reservations order by created_at desc limit 1;` (true).
12. **Watch** the function logs for 24 hours: `reserve_license_use is missing` (step 5 not done) or repeated 5xx. Also watch for `ai-outcome` lines with outcome `redelivered`: each is one extra AI call.

**Abort criteria:** any preflight or verification query not matching section 7; a balance difference that cannot be reconciled; an API "function not found" that `notify pgrst` does not clear; the counter dropping by more than one for one generation; smoke test step 10 not giving `replay` / `key_conflict`.

## 8. Rollback and recovery
**Prerequisites:** the previous Netlify deploy id recorded before step 11; the backup from step 3; the preflight output.
**Order:** (1) redeploy the previous Netlify build (instant; it works against the migrated database, section 6); (2) only if the SQL itself misbehaves, run `supabase/rollback/20261023_03_rollback.sql` (hash above, one transaction, idempotent): it removes `purge_idempotency_hashes`, `finish_redelivery` and the 7-argument function and recreates the 5-argument function exactly as migration 01 defined it, with the same privileges.
**What rollback does not do (by design):** it does not touch `licenses`; it does not restore or spend any generation; it removes no committed or released row; it keeps the five new columns (inert, and keeping them means rolling forward again is lossless); it exposes no data. Tested: balances and rows identical before and after (twice); the previous application keeps charging correctly; the new application fails closed; rolling forward again still recognises steps paid before the rollback.
**What rollback does cost:** durable protection is gone (section 6, consequence 1).
**Ambiguous or partial operations:** do not retry until the read-only state query says which state you are in (step 6). If a customer reports a missing generation, use the support runbook (section 5). Rolling back never restores spent credits: any restoration is a deliberate manual decision.

## 9. Privileges and security evidence
`tests/db/migration03-review.test.js`, `tests/db/reservations.test.js` and `tests/functions/durable-idempotency.test.js`: every function in `public` (not a sample) is executable by `service_role` only; the reservation table is closed to `anon` and `authenticated` (RLS on, no policies); real attempts as `anon` and `authenticated` to call the reservation functions, read `license_reservations`, update or read `licenses` are all rejected; the new functions are `security definer` with a pinned `search_path`. Not verified: Supabase's own default privilege settings in production (the test applies Supabase-style defaults), and the production API gateway.

## 10. Test evidence
Full release run and per-area counts are in the completion report. Targeted (real local PostgreSQL, independent simulated instances): decision table (every outcome of section 1), retention boundary (23 h 59 m recovered, 24 h 1 m refused, 400 days refused), abandoned and failed leases, limit, concurrent identical and conflicting retries, migration applied under load, crash and restart, rollback and roll-forward, compatibility matrix, fault injection (database error during reserve, commit and recovery; AI busy or unusable during recovery), unauthorized roles, free versus paid polish with request ids, daily housekeeping, privacy of stored values. Mutation checks: 20 deliberate breaks of the new logic (SQL, handlers, client), all caught by a test.

## 11. Remaining limitations and risks (plain)
- Exact result recovery is not possible without storing results (section 4); the extra AI call is Flex & Grace's cost.
- Durable protection exists only with migration 03 **and** the new application together.
- Not verified on the real Supabase service, real Netlify or the real Anthropic API.
- The recovery window is 24 hours; a deliberate new press always creates a new operation that can be charged.
- The daily purge depends on `check-code-supply` running; if it stops, input hashes are still erased lazily whenever the code is used.

## 12. Disposition of the five review findings
| # | Finding | Disposition |
|---|---|---|
| 1 | Request-id reuse with changed input could become a new chargeable operation | **FIXED** (`key_conflict`, input-aware cache) |
| 2 | 60-minute idempotency window | **FIXED** (24 h recovery, permanent refusal of stale ids, input hash erased at 24 h; residual limits in section 3) |
| 3 | Redelivery re-runs the AI; original result not stored | **ACCEPTED LIMITATION** (honestly labelled regenerated result; exact recovery needs your approval to store output: **OWNER DECISION** if you want it) |
| 4 | Customers abandoned after the redelivery limit | **FIXED** (support reference, forgiven lapses, new-operation path, honest messages, tested in Chromium) |
| 5 | Rollback and deployment compatibility | **FIXED in code and documentation**; real-service behaviour **NOT VERIFIED** (needs your steps 5 to 12) |

## 13. Owner approvals required
1. Apply migration 03 to production Supabase (section 7, steps 1 to 10).
2. Merge the branch and publish it (step 11).
3. Authorize one paid generation on a personal code for the post-deploy smoke test.
4. Optional decision: whether to store AI output for 24 hours to enable exact recovery (not recommended without a privacy decision).

## Appendix A: the migration, verbatim

```sql
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
```

## Appendix B: the rollback, verbatim

```sql
-- ROLLBACK for migration 03 (20261023_03_request_idempotency.sql). NOT a migration: it lives outside supabase/migrations on purpose and is
-- never run automatically. Use it only if the owner decides to remove the durable-idempotency feature after applying migration 03.
--
-- What it does (one transaction, idempotent):
--   * removes purge_idempotency_hashes, finish_redelivery and the 7-argument reserve_license_use;
--   * recreates the 5-argument reserve_license_use exactly as migration 01 defined it, with the same server-only privileges.
-- What it deliberately does NOT do:
--   * it does not touch `licenses` (balances) or any committed/released reservation row: nothing a customer paid for is changed;
--   * it keeps the five new columns on license_reservations (request_key, input_hash, redelivery_count, redelivering_until, redelivery_lapses). They are inert
--     without the new function, cost nothing, and keeping them means re-applying migration 03 later needs no data migration.
-- Order when rolling back: redeploy the previous Netlify build FIRST (the new build sends request keys and would answer "try again" against
-- the rolled-back database; it never charges), then run this file.

begin;

drop function if exists purge_idempotency_hashes();
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

## Appendix C: the read-only preflight, verbatim

```sql
-- MIGRATION 03 PREFLIGHT: READ-ONLY. Contains only SELECT statements. Safe to run any time, any number of times, in the Supabase SQL editor.
-- Run it BEFORE the migration (expect state "B/C"), AFTER the migration (expect state "D"), and again if a command times out (before any retry).

-- 1. Which database state is this?  A = no reservation table | B/C = migration 01(+02) | D = +03 | R = after rollback (5-arg function, new columns kept)
select
  case
    when not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'license_reservations') then 'A: no reservation table (apply 01 and 02 first)'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'reserve_license_use' and p.pronargs = 7)
         and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'finish_redelivery')
         and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'purge_idempotency_hashes')
      then 'D: migration 03 applied'
    when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'license_reservations' and column_name = 'request_key')
      then 'R: rolled back (5-argument function, new columns kept)'
    else 'B/C: migrations 01/02 only (03 not applied)'
  end as database_state;

-- 2. Functions and their argument counts (expect after migration: reserve_license_use appears ONCE with 7)
select p.proname, p.pronargs as args, p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('reserve_license_use','commit_license_use','release_license_use','consume_tailor_use','refund_tailor_use','finish_redelivery','purge_idempotency_hashes','consume_license_use')
order by p.proname, p.pronargs;

-- 3. New columns (expect 5 rows after migration)
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'license_reservations' and column_name in ('request_key','input_hash','redelivery_count','redelivering_until','redelivery_lapses')
order by column_name;

-- 4. Privileges (expect anon = false and authenticated = false on every row; service_role = true)
select p.proname, p.pronargs as args,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('reserve_license_use','commit_license_use','release_license_use','consume_tailor_use','refund_tailor_use','finish_redelivery','purge_idempotency_hashes','consume_license_use')
order by p.proname, p.pronargs;
select has_table_privilege('anon', to_regclass('public.license_reservations'), 'select,insert,update,delete') as anon_table,
       has_table_privilege('authenticated', to_regclass('public.license_reservations'), 'select,insert,update,delete') as authenticated_table,
       (select relrowsecurity from pg_class where oid = to_regclass('public.license_reservations')) as rls_on;

-- 5. Balances: record before, compare after. The fingerprint changes with REAL customer use; the migration itself changes nothing here.
select count(*) as licenses, coalesce(sum(uses_remaining),0) as generations_remaining, coalesce(sum(max_uses - uses_remaining),0) as generations_spent,
       md5(coalesce(string_agg(code || ':' || uses_remaining || '/' || max_uses, ',' order by code), '')) as balance_fingerprint
from public.licenses;

-- 6. Reservation health (in-flight steps right now; a quiet window shows 0 live). In state A this query errors because the table does not exist: expected.
select status, count(*) as rows, count(*) filter (where status = 'reserved' and expires_at > now()) as live_now
from public.license_reservations group by status order by status;

-- 7. Is a migration session still running? Check this BEFORE any retry after a timeout.
select pid, state, now() - query_start as running_for, left(query, 80) as query_start_of
from pg_stat_activity
where datname = current_database() and pid <> pg_backend_pid()
  and (query ilike '%request_idempotency%' or query ilike '%finish_redelivery%' or query ilike '%reserve_license_use%' and query ilike '%create or replace%');
```
