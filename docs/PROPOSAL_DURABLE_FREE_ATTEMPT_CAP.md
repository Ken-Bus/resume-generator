# Proposal: durable free-attempt cap (database migration 03)

**Status: PROPOSAL ONLY. Not written as a migration file, not applied, not deployed. Needs an explicit owner decision.**

## Why
A "free attempt" is an AI call that cost us money but was not charged to the customer: the result was unchanged/cosmetic (P201) or every change was withheld by the integrity checks (P202). They are capped per access code (3 per 15 minutes, 10 per day: `NOCHANGE_*` in `_lib/config.js`) so they cannot become unlimited free AI.

Today the cap lives in `netlify/functions/_lib/nochange.js`, **in the memory of one serverless instance**. Consequences:

| Weakness | Effect |
|---|---|
| Each instance has its own counter, and instances are recycled | Under concurrent or spread-out traffic the real limit is higher than 3 / 10 (not unlimited: every call still needs a code with generations left, is size-capped, and is bounded by the failure throttle only if it fails). |
| Check happens before the reservation and the record after the AI call | Several simultaneous requests can all pass the check, then all record. |
| Restart/redeploy resets it | The daily limit is not a real daily limit. |

Worst case today is a small multiple of intended free-attempt cost for a customer who holds a valid code. It is not a customer-facing correctness risk, and it is not a way to get paid output for free (nothing flagged is ever returned). That is why this is documented rather than urgent.

## Proposed change (additive, idempotent, one file)

`supabase/migrations/20261022_03_free_attempt_cap.sql` (name is a suggestion):

1. **Mark free releases.** `alter table license_reservations add column if not exists release_kind text check (release_kind in ('nochange','flagged'));` Nullable, no default: every existing row stays valid and is simply "not a free attempt".
2. **Index for the count** (partial, small): `create index if not exists license_reservations_free_idx on license_reservations (code, released_at) where release_kind is not null;`
3. **Replace `reserve_license_use`** with the same function plus three trailing parameters with defaults: `p_free_window_seconds integer default 900`, `p_free_window_max integer default 3`, `p_free_day_max integer default 10`. After the existing `for update` row lock and housekeeping, count rows with `release_kind is not null` and `released_at` inside the window / last 24 h; if over a limit return `outcome = 'throttled'` with `retry_after_seconds` (the same shape the failure throttle already returns). Because it runs under the same row lock as reserve/commit, concurrent requests cannot all pass.
   - Free releases are `status = 'released'` and `failure_counted = false`, so the existing failure counting (`status = 'expired' or (released and failure_counted)`) is untouched: **a free attempt never counts as a failure and a failure never counts as a free attempt.**
   - Old rows are already deleted after 30 days by the existing housekeeping.
4. **Recording the kind** is a plain table update by the server after `release_license_use(id, false)`: `update license_reservations set release_kind = 'nochange'|'flagged' where id = :id and status = 'released'`. `service_role` already holds `update` on the table; no new grant is needed and no new function is needed.
5. **App change (separate commit, after the migration is applied):** `polish-resume.js` stops calling the in-memory `check` as the authority and relies on the `throttled` answer; the in-memory cap stays as a fallback when the column or new parameters are missing (`42703` / `42883` / `PGRST202`), exactly as the app already falls back for other missing database objects. The customer-facing 429 wording does not change.

## Order of rollout (the order matters)
1. Take a Supabase backup / note the current function definitions (`\df+ reserve_license_use`).
2. Apply migration 03. **Old code keeps working** against the new database: the added parameters have defaults and the old call passes five arguments.
3. Deploy the app change.
4. Re-run the database tests against the live schema snapshot; no paid AI call is needed because the database tests prove the cap.

Never deploy the app change first: it would call a column that does not exist (it falls back safely, but then the durable cap is silently not in force).

## Rollback
- **App:** redeploy the previous commit. The previous app ignores the column and the extra parameters.
- **Database (only if the new function misbehaves):** re-create the previous five-parameter `reserve_license_use` from `20261020_01_license_reservations.sql` (same definition, `create or replace`), then re-run its `revoke execute ... from public, anon, authenticated` / `grant execute ... to service_role` lines. The added column and index are harmless and can stay; dropping them (`alter table ... drop column release_kind; drop index ...;`) loses only the history of free attempts.
- Because `create or replace` with a different parameter list creates a second overload, the migration must `drop function if exists reserve_license_use(text, integer, integer, integer, integer);` before creating the 8-parameter version (migration 01 does the same for its own earlier signatures), and the rollback must drop the 8-parameter one first. Otherwise two overloads exist and a call with five arguments can become ambiguous.

## Compatibility
- Old rows: unaffected (`release_kind` null).
- In-flight reservations during the migration: the row lock is taken inside the function; a call that started before the replacement finishes under the old definition. No reservation is lost or double-charged because commit/release functions are not changed.
- Tailor, export, `verify-license`, `commit_license_use`, `release_license_use`, `consume_tailor_use`, `refund_tailor_use`: unchanged.
- Charging rules, price, five-generation entitlement, Tailor allowance: unchanged.

## Security permissions (must be identical to migration 01)
- New function keeps `security definer`, `set search_path = public`.
- `revoke execute on function reserve_license_use(text, integer, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;` then `grant execute ... to service_role;` **using the new signature**. Forgetting this is the main risk: a new function signature is executable by `public` by default in Postgres.
- Table grants/RLS unchanged (RLS on, no policies, `service_role` only). No new table, no new role, no new secret.
- After applying, verify with the existing live snapshot checks (`tests/db/live_snapshot.sql`) and `get_advisors` (security) in Supabase: no function executable by `anon`/`authenticated`.

## Test requirements (extend `tests/db/reservations.test.js`)
Must pass before the migration is applied to the real project:
1. Free window cap: 3 rows with `release_kind` set inside 15 min → 4th `reserve_license_use` returns `throttled` with `retry_after_seconds` > 0 and creates no reservation.
2. Daily cap: 10 in 24 h → `throttled`; after 24 h (move `released_at` back in the test) allowed again.
3. A free attempt is never a failure: with 3 free rows the failure throttle (6 / 15 min, 30 / day) is unaffected, and 6 counted failures do not reduce the free allowance.
4. Concurrency: N parallel reserves for one code with 2 free attempts already used admit exactly one more.
5. Other codes are unaffected.
6. Old five-argument call shape still works and returns the same results as before for codes with no free attempts.
7. A reservation that is committed (charged) never has `release_kind`.
8. Grants: `anon` and `authenticated` cannot execute the new signature or read the table; `service_role` can.
9. Re-running the migration file twice is a no-op (idempotent).
10. App side: `tests/functions/nochange.test.js` keeps the in-memory fallback test; add one test that a `throttled` answer from `reserve` produces the same 429 message.

## Decision needed (only if you want this before launch)
Approve migration 03 as described, or accept the in-memory cap for launch. Recommendation: **accept for launch, schedule migration 03 afterwards** — the exposure is bounded cost for holders of valid codes, and a production schema change is the larger risk right now.
