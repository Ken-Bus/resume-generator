# Migration 05 review package: included AI Polish and the 96-hour completion period

**Status: prepared for review. NOT applied to production. Nothing here has been merged, pushed or deployed.**
Files: `supabase/migrations/20261027_05_included_polish.sql`, `supabase/rollback/20261027_05_rollback.sql`, `docs/MIGRATION_05_PREFLIGHT.sql`, `docs/MIGRATION_05_POSTCHECK.sql`, `tests/db/included-polish.test.js`.
Base: main `60073993`. Verified = checked in the code or by a local test. Proposed = a design that does not exist yet.

## 1. What migration 05 changes (plain language)

| Change | Why it is needed |
|---|---|
| Three new empty columns on the existing `license_reservations` table: `kind` (analyze or polish), `included_polish_by`, `included_from` | The database must remember which paid step was an Analyze, and which Polish used that Analyze's included Polish. Existing rows are left as they are, so no old Analyze gets a retroactive credit. |
| A unique index on `included_polish_by` | "One included Polish per Analyze" becomes a database rule. Even a coding mistake cannot give one Analyze two Polishes. |
| `reserve_license_use` gains one optional switch, `p_allow_included` (off by default), and reports which Analyze it would use | With the switch off (what Analyze and today's code use) it behaves exactly as before. With it on, the oldest unused included Polish of that code can be used even at 0 generations. The old 7-argument version is replaced, so only one version exists. |
| `commit_license_use_with_result` keeps its inputs; if the step is using an included Polish it claims it, commits without lowering the balance, and stores the same encrypted copy | The claim happens inside the same transaction as the commit, under the existing license lock, so it is all-or-nothing and can succeed only once. If someone else already took it, the answer is `included_gone` and nothing is written or charged. |
| New read-only function `license_access_status` | Tells the application whether a code is `active`, in its 96-hour `completion` period (with the end time), or `ended`. It stores nothing. |

Nothing is dropped except the old 7-argument reserve (replaced) and the old commit function (replaced with the same inputs). No balance, code, committed step or recovery copy changes. The migration is rerunnable.

## 2. How the rules map to the database (all Verified by `tests/db/included-polish.test.js`)

- **One included Polish per committed paid Analyze:** `kind` is recorded once, on the first commit of an Analyze. An Analyze committed the old way has no kind and no credit.
- **Meaningful result only:** the application commits only when its existing scoring says "charge". Failed, unchanged or insignificant results are *released* as today, and the database never sees the included Polish at all. Tests: release and lapsed lease both leave the credit unused.
- **Atomic and one-time:** claimed under the license row lock plus a unique index. Two simultaneous commits give one `committed` and one `included_gone`.
- **Duplicates and retries:** the existing request key and input hash decide a repeat as `replay`; a replayed included Polish returns the same step and uses nothing more.
- **Persists across browsers and sessions:** the credit lives in the database and is found by access code.
- **Non-expiring:** there is no date check. A credit 400 days old is still usable (tested).
- **Zero generations:** the reserve step skips the "no generations left" refusal only when it holds an included Polish. Failure throttling still applies. At zero with no credit, the step is refused even if it asks.
- **Two live attempts never hold the same credit** (the second request simply does not get it).
- **Recovery:** the included Polish is stored in `result_recovery` like any other paid step (24 hours), so the existing restore works unchanged.
- **Tailor:** the migration does not touch Tailor. The included Polish never creates Tailor runs. In the application stage it must re-issue a Tailor token for the **parent Analyze**, whose remaining runs are already counted.

## 3. The 96-hour policy

**Does it change the migration design?** Barely. It adds one read-only function, `license_access_status`, to migration 05, for these reasons: it depends on the new `kind` and `included_polish_by` columns, it adds no table, column or stored data, and it needs no separate deployment step. No timer is stored: the period is derived as *the newest committed paid step + 96 hours*, only when the code has no generations and no unused included Polish. So it is correct for every path (the last generation, the last included Polish, an admin top-up) without anything having to remember to start a clock.

**Verified behaviour (tested):** a code with generations or an unused included Polish is `active` (no end date). With neither, it is `completion` until 96 hours after its last benefit, then `ended`. A top-up returns it to `active`. The period grants no AI: reserve still refuses. Older codes with no recorded step fall back to `licenses.last_used_at`; a code with neither is `ended`.

**Proposed, application stage (not in this migration):** `verify-license` returns the state and end time and accepts `completion`; **`export-resume` must also enforce the state** (today it allows any existing code, and `tests/functions/export.test.js:73` asserts "downloads still work after all five are used", which must change to match the policy); the page shows the countdown and the save-your-resume reminder. The AI endpoints need no change: they are already refused by reserve at zero.

**Customers affected on release (Proposed, needs your awareness):** a code that reached 0 generations more than 96 hours before the deployment will be `ended` immediately. Those customers are already locked out of the sign-in screen today (verified), so this is no worse than now.

## 4. Can the complete resume be reliably recovered for four days? **No, not with what exists.**

Verified in the code:

| What | Where it lives | How long | Across devices |
|---|---|---|---|
| The AI's Analyze or Polish **result**, at the moment it finished | `result_recovery`, encrypted | 24 hours maximum (a database rule: `expires_at <= created_at + 24 hours`; hourly purge) | Yes, with the access code. Three newest only. |
| The customer's **edited** resume, chosen template, pasted original text, polish "undo" copies | The browser's own draft (`localStorage`, `fg_draft_v2`) | 14 days | **No.** It is never uploaded. Clearing browser data or a private window removes it. |
| The access code itself | The browser tab's session storage | Until the tab closes | No |
| Manual edits made after an AI step | Only in the browser draft | | |
| Tailor results | Not kept anywhere on the server | | |

So within the 96 hours: a customer on the same browser still has the full draft and can download. On a new device, in a cleared browser, or after more than 24 hours, the server holds nothing they can restore. 96-hour **sign-in and download access** is feasible and is delivered by `license_access_status`. 96-hour **recovery of the finished resume** is not, and **no screen or FAQ may promise it.** Safe wording: *"You can keep editing and downloading for 4 days after your last AI step. Please download your resume and save it somewhere safe (your computer or a USB drive). Your draft is kept only in this browser, on this device."*

**What true four-day recovery would require (NOT included; stop for approval):**
1. New server-side storage of the whole edited resume, encrypted with `RESULT_ENCRYPTION_KEY`: either a new table or relaxing the 24-hour ceiling and the `fn` list in `result_recovery`. That is a schema change and a retention change.
2. A new "save" endpoint called as the customer edits (debounced), with rate limits and size caps.
3. A privacy and retention decision: more personal data (contact details, work history) held longer; purge job; backup retention; updating the FAQ and privacy wording.
4. New tests: encryption, scope per code, expiry at 96 hours, purge, conflict between two devices.
Recommendation: **do not do this before launch.** The reminder wording plus the 14-day local draft covers the realistic case. Revisit after launch if customers lose work.

## 5. Does the Polish screen support accept or reject? **Partly. After the fact, not before.**

Verified in `wizard.js` and `index.html`:
- There is **no preview before applying.** When the server returns a meaningful result, the page replaces the resume immediately (`state.data = parsed`). The generation (or, after migration 05, the included Polish) was committed on the server first.
- The customer can **reject afterwards:** "Restore my wording" for one part, "Restore all my original wording", and "Restore what I wrote before the first polish". The originals are kept in `polishOriginal` and `polishBaseline`, which are saved in the local draft (so they survive a refresh on the same device, up to 14 days).
- Rejecting does **not** give anything back. That matches the policy ("rejecting a meaningful result does not restore the included allowance"): the server commit is already final.
- **Gap (Verified):** if a Polish is restored from the 24-hour recovery copy on a device with nothing on screen, there is no "original" to go back to (`index.html:665`). The server never keeps the customer's original text. The restore already asks before replacing on-screen work and keeps an undo, but it cannot offer "restore my wording" if there was no wording on that device.

Minimum changes (Proposed, wording only, no new interface): the Polish result message must say the included Polish or generation *stays used even if you restore your own wording*; the confirmation before an included Polish should say the same. No code change is required for the policy itself.

## 6. Compatibility

| Caller | Calls | Effect of migration 05 |
|---|---|---|
| Published build `0a1a014` | `reserve_license_use` with 5 named arguments; `commit_license_use`; `release_license_use`; tailor functions | Works unchanged (tested with those exact named arguments). It never asks for an included Polish, so none is used or created beyond the dormant `kind` write it does not make. |
| Release candidate `60073993` | `reserve_license_use` with 7 named arguments; `commit_license_use_with_result` with 7 | Works unchanged (extra result columns are ignored). Its commits now record `kind`, so **Analyze steps made by this build earn credits that its code cannot yet use**; they remain available once the new build ships (non-expiring). |
| Future build | Sends `p_allow_included` | Requires migration 05 first. Against a database without it, it fails safely (503, nothing charged). |

Apply order: backup, pre-check, migration 05, post-check, then deploy the new application build.

## 7. What could go wrong, and how it is prevented

| Risk | Prevention |
|---|---|
| Two tabs both use the included Polish | Lock plus unique index; second gets `included_gone`, nothing charged (tested) |
| A failed or empty AI result consumes it | Claimed only inside the commit, never at reserve; a release leaves it (tested) |
| A crash between the claim and the recovery copy | One transaction: both happen or neither (the existing atomicity test pattern) |
| Customer is charged when a credit was available | Reserve prefers the credit whenever the request asks; the application always asks. The application must also send `expectIncluded`, and never turn a missing credit into a charge silently (application stage) |
| A credit used by someone else's code | The claim requires the same `code` (tested) |
| Old Analyze steps get free Polishes | No `kind`, no credit (tested) |
| The central billing functions regress | Existing suites re-run on top of 05 (section 8); the default call path is textually the 03 body plus guarded additions |
| Rollback loses information | It keeps every row and column; only function bodies change back (tested) |
| A customer with zero entitlements keeps downloading forever | Derived end time; enforcement in `export-resume` (application stage) |

Residual, accepted: a customer could Analyze a very short text and spend the included Polish on a large resume (bounded cost of roughly $0.13, an estimate from the cost notes). Shared access codes share one set of credits, as they already share generations.

## 8. Tests (local PostgreSQL only; no AI, no Supabase)

- New: `node --test tests/db/included-polish.test.js` (16 checks: additive and rerunnable, kind/credit rules, only a Polish that asks, claim without lowering the balance, zero generations, failures/lapsed lease/release, simultaneous commits, replay, scope, never expires, the 96-hour states, deployed-build calls, privileges, rollback and re-apply).
- Older suites layered on top of 05: `WITH_MIG5=1 node --test tests/db/<suite>.test.js` (the helper applies 05 right after 04). The results are in the report.
- **Expected differences when 05 is layered on (verified to be signature or ordering checks, not behaviour):** the older suites hard-code the *7-argument* `reserve_license_use` and the *state before 05* (several privilege checks, the 04 pre/post-check SQL, "schema.sql equals the migrations", and "apply 04 twice"). They are intentionally left unchanged: they describe the database as it was after 03/04, and they still pass when run the normal way (without 05).
- **Operational consequences of that finding:**
  1. After 05 is applied, use `docs/MIGRATION_05_POSTCHECK.sql`. The older `docs/MIGRATION_04_POSTCHECK.sql` will report FAIL ("a migration 03 object is missing") because it looks for the 7-argument reserve. That FAIL is expected after 05.
  2. Do not re-run migration 04 after 05. It would stop safely with "cannot change return type of existing function" and the transaction rolls back; nothing is damaged. 05 itself is rerunnable.
  3. **Roll back in reverse order only: 05, then 04, then 03.** The 03 and 04 rollback files assume 05 is not there. Run after 05 they would leave two `reserve_license_use` versions (5 and 8 arguments) and the 03 rollback test matrix ("state R3") then shows keyed steps refused with 503 (nothing charged). This was seen when 05 was layered under the compatibility suite and is expected; it is a rollback-order rule, not a defect in 05.
  4. `supabase/schema.sql` (the fresh-install snapshot) does not include 05. A fresh install would apply the migrations in order, not that file. Updating it is deferred (it has its own test that compares it with the migrations).

## 9. Approval points before any production step

1. Review of this package and the SQL (this stage ends here).
2. Decision on the four-day recovery question: launch with the reminder wording only (recommended), or approve a separate storage design first.
3. Permission to push the branch (no pull request or merge yet).
4. A fresh backup per `docs/PRODUCTION_BACKUP_RUNBOOK.md`, then the pre-check, then applying 05, then the post-check, each by the owner.
5. A fresh isolated test license (not created yet).
6. Application stage (separate assignment): the code, the `export-resume` enforcement, the page wording and the countdown.
