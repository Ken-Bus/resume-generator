# Migration 03 + 04 release verification: sequence, key setup, concurrency finding, checklist

Feature branch `feature/guided-resume-and-export-fixes`. Every command below is owner-run; **nothing here was executed against production, no secret exists anywhere, no migration is applied.** All evidence is from a disposable local PostgreSQL 16 with mocked AI. Companion files: `docs/MIGRATION_04_PREFLIGHT.sql`, `docs/MIGRATION_04_POSTCHECK.sql` (both SELECT-only), `tests/db/migration04-verification.test.js`, `docs/MIGRATION_04_RECOVERY_PACKAGE.md`, `docs/MIGRATION_03_REVIEW_PACKAGE.md`.

## 1. Read-only preflight and post-migration SQL

| File | When | Contents |
|---|---|---|
| `docs/MIGRATION_04_PREFLIGHT.sql` | Before 04 (and again after 03) | database state (A, B/C, D, E, PARTIAL), prerequisites, name collisions, privileges of the functions 04 builds on, balance fingerprint (**record it**), reservation health, running-session check, size |
| `docs/MIGRATION_04_POSTCHECK.sql` | Right after 04, after the app deploy, after the first hourly purge | **query 0 is a one-row verdict: `PASS` or `FAIL: <first failing check>`**; then schema, constraints (incl. the 24-hour ceiling), permissions (table and the four functions: security definer, `search_path` pinned, no anon/authenticated/PUBLIC execute, service_role yes), function availability, migration 03 objects intact, balance reconciliation, stored-copy sanity (over-ceiling and orphan copies must be 0) |

Properties, each tested: only `SELECT` is used (the script is run inside `BEGIN READ ONLY` in the test, so any write would fail it); it never calls `list_recoverable_results` or `purge_recoverable_results` (they delete expired rows by design), availability is proven from the catalog plus one harmless lookup of a code that cannot exist; on a database without migration 04 the post-check stops with `relation "public.result_recovery" does not exist`, which **is the FAIL signal**.

Evidence (`tests/db/migration04-verification.test.js`, 6 tests pass): the preflight reports the right state on B/C, D and E; the post-check returns `PASS` on a correctly migrated database; and it returns `FAIL` with the right reason for each of 11 injected defects (anon read, authenticated write, RLS off, service_role revoked on the table, PUBLIC execute, anon execute, service_role execute revoked, missing function, 24-hour rule dropped, a migration 03 object missing, an orphan copy). While writing it the test caught a real bug in my first version of the 24-hour check (PostgreSQL prints the interval as `24:00:00`, not `24 hours`); fixed.

## 2. Migrations 03 and 04 together: sequence

**Dependencies (verified in the SQL):** 04 calls `commit_license_use(uuid)` from migration 01 and does not call anything added by 03. So 04 *can* technically apply on a database without 03 (tested), but the **new application needs both** (it sends request keys, which only 03's 7-argument `reserve_license_use` accepts, and it refuses to charge without 04's copy). Hence the order is always **03, then 04, then deploy**.

**Forward order (supersedes the "deploy" step of the 03 package alone).** The 03 package's step 11 ("Deploy the feature branch") was written before migration 04 existed. Followed on its own it would deploy a build that answers "try again" (503) on every Analyze and Polish, because 04 and the key are missing. Use this combined order:

| # | Step | Gate |
|---|---|---|
| 0 | Backup / point-in-time recovery confirmed, `licenses` and `license_reservations` exported, previous Netlify deploy id recorded, quiet window | G0 |
| 1 | Run `MIGRATION_03_PREFLIGHT.sql`; state must be B/C; record the balance fingerprint | G1 |
| 2 | Set `RESULT_ENCRYPTION_KEY` in Netlify (section 3). The old application ignores it | G2 |
| 3 | Apply migration 03; run the 03 after-queries; smoke-test the **old** deployed app (counter drops by exactly one) | G3 |
| 4 | Run `MIGRATION_04_PREFLIGHT.sql`; state must be **D** and every prerequisite true | G4 |
| 5 | Apply migration 04; run `MIGRATION_04_POSTCHECK.sql`; query 0 must say `PASS`; balances equal step 1 plus real use | G5 |
| 6 | Merge and deploy the feature branch (owner approval). Confirm the hourly `purge-recovery` function is listed | G6 |
| 7 | Key and recovery smoke checks (section 3, "Check") and one paid smoke test with the owner's own code | G7 |
| 8 | After about an hour: rerun the post-check; `expired_awaiting_cleanup` is 0 or only recent | G8 |

**Rollback order (reverse):**
1. **Redeploy the previous Netlify build first.** The new build refuses paid steps against a rolled-back database (nothing is charged), and the previous build uses neither migration's objects.
2. If the SQL itself misbehaves: `supabase/rollback/20261024_04_rollback.sql` (drops the four functions and the table; at most 24 hours of copies are lost; no balance or reservation row is touched).
3. Only then, and only if 03 must go too: `supabase/rollback/20261023_03_rollback.sql`. Both scripts are single-transaction and idempotent.
4. The key can stay in Netlify; it is inert without the new build.

Evidence (same test file): on a seeded database with one real charge, migration 03 → 04 → 04 again → rollback 04 → rollback 04 again → rollback 03 → rollback 03 again → 03 → 04 left `licenses` balances and every `license_reservations` row identical at every step, in both directions, and the post-check was `PASS` again after rolling forward. **Wrong order is detected, not silent:** rolling back 03 while 04 stays makes the post-check say `FAIL ... migration 03 ...`, balances intact; re-applying 03 repairs it. `tests/functions/compat-matrix.test.js` shows what each application does in each state (new app refuses with 503, nothing charged, no AI call; previous app keeps charging correctly).

**Mixed-state summary:** DB at 03 only and new app deployed → paid steps refused (503), no charge; DB at 04 without 03 → same; key missing → same; previous app on any state → unchanged behaviour (its known limitation: a lost reply retried on a cold instance can charge again, exactly as before 03).

## 3. Generating and configuring `RESULT_ENCRYPTION_KEY` (never printed, never committed)

Rules: at least 32 characters (the code enforces 32; below that the app treats the key as missing and refuses paid steps); **different from `TAILOR_TOKEN_SECRET`**; never pasted into an AI chat, an email, a ticket, a commit, `netlify.toml`, a `.env` file in the repo (`.env` is git-ignored, but do not rely on that) or a screenshot. Ken's standing rule (CLAUDE.md #8) applies: an AI must not ask for it and you must not give it to one.

**A. Generate straight to the clipboard (nothing appears on screen).** Pick your system:
- macOS: `openssl rand -base64 48 | tr -d '\n' | pbcopy`
- Windows PowerShell: `$b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) | Set-Clipboard`
- Linux: `openssl rand -base64 48 | tr -d '\n' | xclip -selection clipboard`
- Or use your password manager's generator (random, 40 or more characters) and copy from there.

**B. Save it in your password manager first** (an entry named "Resume Generator RESULT_ENCRYPTION_KEY", pasted from the clipboard). Do not skip: if the key is lost, stored copies become unreadable (they expire within 24 hours anyway; nothing else depends on it).

**C. Set it in Netlify (menu wording may differ slightly):** Site configuration → Environment variables → Add a variable → key `RESULT_ENCRYPTION_KEY` → paste → tick **Contains secret values** → scope **Functions only** (not Builds) → deploy context **Production**. Use a **different value** for Deploy Previews if you want previews to work; leaving it unset in previews just makes previews refuse paid steps safely. Save. Do not redeploy yet (section 2, step 6 does that after the migrations).

**D. Clear the clipboard** by copying any harmless text.

**Check (no secret is revealed; run after the deploy).** Two steps, because the first cannot see migration 04:
1. *Key present (an unknown code never reaches the database function):*
`curl -s -X POST https://<your-site>/.netlify/functions/recover-result -H 'Content-Type: application/json' -d '{"code":"FG-ZZZZ-ZZZZ","action":"list"}'`
HTTP 200 with `{"results":[]}` means the key is present and at least 32 characters. HTTP 503 means it is missing or too short (look for `R310` in the function log): STOP the release. Nothing was charged.
2. *Migration 04 reachable through the API, using your OWN access code without printing or saving it (the code is a credential):*
`read -rs CODE; curl -s -X POST https://<your-site>/.netlify/functions/recover-result -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\",\"action\":\"list\"}"; unset CODE`
(type the code at the hidden prompt and press Enter). HTTP 200 with `"results":[...]` **and** a `"usesRemaining"` number proves the API can call `list_recoverable_results`. HTTP 503 means migration 04 is not applied or the API schema cache has not refreshed: run `notify pgrst, 'reload schema';` in the SQL editor once and repeat; if it persists, STOP.
Each unknown-code lookup counts toward the per-client guess limit (30 per 10 minutes); run each once.

**Rotation:** set the new value as `RESULT_ENCRYPTION_KEY` and move the old value to `RESULT_ENCRYPTION_KEY_PREVIOUS`; redeploy; after 24 hours delete the previous one. Never print either.

## 4. The B2 concurrency-test anomaly

**What was seen:** during development the test "B2 parse: concurrent failing bursts cannot exceed budget + uses remaining in total AI calls" (`tests/functions/endpoints.test.js`) failed once with `6 !== 5` while another suite was running, then passed on every rerun. The failing assertion line was not captured at the time.

**Work done now:** (a) 12 isolated runs, 10 runs under heavy CPU load (8 busy processes on 4 cores) and 6 runs executed as simultaneous pairs: **0 failures**, so the failure was not reproduced with the test as it was run. (b) A replica of the exact sequence (6 bursts of 20 concurrent failing requests, then 20 more) on a disposable local database, 120 iterations: **2 iterations reproduced `before = 5, after = 6`** (1.7%). (c) 400 single bursts: AI calls per burst of 20 concurrent requests were 0 → 4, 1 → 314, 2 → 81, 3 → 1; in all four zero-call bursts **every one of the 20 requests was answered HTTP 409 "busy"**, no AI call, nothing charged.

**Mechanism (reproduced, not merely inferred):** the per-code failure budget (6 costly failures in the window, enforced in the database by `reserve_license_use`, `supabase/migrations/20261023_03_request_idempotency.sql`) counts *recorded failures*. A burst of 20 normally lets one request through to the AI; occasionally all 20 yield to each other (the documented worst case in `netlify/functions/_lib/inflight.js`: "a very close pair both yield and the customer simply tries again") and sometimes two run one after the other. The test assumed 6 bursts always record exactly 6 failures. When one burst records none, only 5 failures exist, the budget of 6 is correctly **not** yet reached, and the next burst's request legitimately reaches the AI: `6 !== 5`. The two reproduced examples were bursts `[0,1,1,1,1,1]` and `[1,1,1,1,0,1]`. This matches the original message exactly. **Status: the cause of the reproduced failure is verified; that the single original occurrence had this same cause is highly consistent but cannot be proven, because its failing line was not recorded.**

**Could production behaviour be affected?**
- **Billing: no.** Failed attempts never charge: across the replica all 120 iterations ended with the balance unchanged (5). A charge happens only in `commit_license_use_with_result` after a valid result, and the SQL decision table and concurrency tests (`tests/db/reservations.test.js`, `migration03-review.test.js`) show a code can never be charged beyond its remaining uses.
- **Rate limit / failure budget: working as designed.** The budget is a database rule, global across all server instances, not in-memory. The invariant that matters held in every iteration: total AI calls never exceeded budget + uses remaining (maximum observed 7, bound 11; 0 violations).
- **Customer-visible effect (rare):** under many simultaneous requests for one code a customer can get a spurious "busy, try again" (HTTP 409), no charge. A normal double-click produces 2 requests, not 20. Cost impact at worst: one extra AI call on a code that is already failing, bounded by the budget; Anthropic's $20 monthly limit is the hard backstop.
- **In-memory limiters** (per-IP guess limits in `rate.js` and `recover-result.js`) are per server instance and best-effort by design; they were not involved in this anomaly.

**Action taken:** the test was wrong, not the product. It now bursts until the budget engages (HTTP 429, max 20 bursts) and then asserts the real invariants (budget engaged, total AI calls ≤ 11, every later request refused, no further AI calls, balance unchanged). 20 consecutive runs pass. No application code changed.

## 5. Minimal production release checklist (PASS / FAIL / STOP)

Meaning: **PASS** = proceed to the next gate. **FAIL** = the check is not met; do not proceed; follow the stated action (a safe retry or fix) and repeat the gate. **STOP** = halt the whole release and, where stated, roll back; do not retry until the owner and reviewer have looked at it.

| Gate | Check | PASS | FAIL (fix, repeat) | STOP |
|---|---|---|---|---|
| G0 | Backup/PITR covers now; CSV exports of `licenses` and `license_reservations`; previous Netlify deploy id written down; owner approvals recorded | all four done | any missing: do it first | no backup possible |
| G1 | `MIGRATION_03_PREFLIGHT.sql` query 1; record balance fingerprint | state B/C | state A: apply 01 and 02 first | state D or R unexpectedly, or a running migration session shows in query 7 |
| G2 | Netlify has `RESULT_ENCRYPTION_KEY` (Functions scope, Production), 32+ characters, differs from `TAILOR_TOKEN_SECRET`, stored in the password manager | yes | fix and re-save | the key appeared in a chat, commit or log: treat as exposed, make a new one |
| G3 | Apply 03; 03 after-queries; old app smoke test | one `reserve_license_use` with 7 args, privileges closed, counter drops exactly 1 | editor timed out: DO NOT re-run; check state first (03 package step 6) | balance differs by more than real use; counter drops by more than 1 |
| G4 | `MIGRATION_04_PREFLIGHT.sql` | state **D**, 5 prerequisites true, 0 collisions | state B/C: go back to G3 | state PARTIAL or E unexpectedly |
| G5 | Apply 04; `MIGRATION_04_POSTCHECK.sql` query 0 | `PASS`; balances equal G1 plus real use | `relation does not exist`: the apply failed, check the error, retry once after confirming state D | any `FAIL:` verdict other than a missing apply; fingerprint differs without matching committed charges |
| G6 | Merge + deploy (owner approval); hourly `purge-recovery` listed in Netlify | deployed, function listed | deploy failed: redeploy | merge requested without G5 PASS |
| G7 | Both key checks in section 3 (200 with an empty list for the unknown code; 200 with `usesRemaining` for your own code); then one paid Analyze with the owner's own code, close tab, reopen, "Restore my result" | both 200; restore returns the same result; counter drops exactly 1 in total | 503: find `R310` or the 04 error in the logs, fix, repeat | counter drops more than 1; result missing after a charge; any error showing resume text, a code or a key |
| G8 | About an hour later: post-check queries 8 and 8b | expired_awaiting_cleanup is 0 or recent; orphans 0; over_24h 0 | purge not running: check the schedule | any copy older than 24 hours is still readable; orphans or over-ceiling copies above 0 |
| G9 | 24-hour watch of function logs | no `R310`, no repeated 5xx, no `invalid recovery copy` | investigate each | repeated charges without copies, or anything that exposes content |

**Rollback trigger (any STOP after G6):** redeploy the previous Netlify build, then follow section 2 rollback order; re-run the post-check or preflight to confirm the state; tell the reviewer.
