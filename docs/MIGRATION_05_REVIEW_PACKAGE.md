# Migration 05 review package: included AI Polish and the four-day completion period

**Status: prepared for review. NOT applied to production. Not pushed, merged or deployed.**
Branch (local only): `feature/included-polish-migration-05`, based on main `60073993`.
Files: `supabase/migrations/20261027_05_included_polish.sql`, `supabase/rollback/20261027_05_rollback.sql`, `docs/MIGRATION_05_PREFLIGHT.sql`, `docs/MIGRATION_05_POSTCHECK.sql`, `tests/db/included-polish.test.js`, and a small helper switch in `tests/db/helpers.js`.
**Verified** = checked in the code or by a local test on a disposable PostgreSQL 16. **Proposed** = a design or application change that does not exist yet. No production system, license, Supabase project, Netlify setting or Founder OS file was touched, and no AI was called.

## 0. At a glance

- Migration 05 is **additive**: three empty columns, three indexes, two replaced functions and one new read-only function. It changes no balance, no code and no existing row.
- On its own it is **dormant for customers**. Nothing changes on screen until the application stage ships (the included-Polish button, the zero-balance sign-in fix, download enforcement and the four-day reminder).
- **No genuine regression was found.** Every older-test difference is traced to a test that hard-codes the pre-05 state (section 5).
- **Four-day recovery of the finished resume is not supported** and must not be promised. Four-day sign-in and download access is supported (section 3).
- The main remaining work is **application-side**: the database makes duplicate use impossible, but "never charged unexpectedly" also needs the application rules in section 2.3.

## 1. The exact database changes

| # | Object | Change | Why |
|---|---|---|---|
| 1 | `license_reservations.kind` | New nullable column, 'analyze' or 'polish'. Set once, when a step is first committed. | The database must know which paid step was an Analyze. Old steps stay empty, so **no retroactive credits**. |
| 2 | `license_reservations.included_polish_by` | New nullable column on an Analyze: the Polish that used its included Polish. Empty means still available. | The credit and its single use are recorded on the paid Analyze itself. |
| 3 | `license_reservations.included_from` | New nullable column on a Polish reservation: the Analyze it intends to use. | Lets the commit step know it must not take a generation. |
| 4 | Index `license_reservations_included_polish_by_uq` | **Unique** on `included_polish_by` where not null. | "One included Polish per Analyze" becomes a database rule. |
| 5 | Indexes `..._included_open_idx`, `..._included_from_idx` | Partial lookup indexes. | Finds a code's unused credits without scanning its history. |
| 6 | `reserve_license_use` | The old 7-argument version is dropped and replaced by an 8-argument one. The new last argument, `p_allow_included`, defaults to false. It returns one extra column, `included_from`. | With the default, behaviour is the migration-03 body unchanged. With it on, the oldest unused credit of that code can be chosen, even at 0 generations. |
| 7 | `commit_license_use_with_result` | Dropped and recreated with the same 7 inputs; it returns two extra columns, `included` and `included_from`. A step without `included_from` calls the existing `commit_license_use` exactly as before and records `kind`. A step with it claims the credit atomically, commits **without lowering the balance**, and stores the same encrypted recovery copy. | The one place where a generation is or is not spent. |
| 8 | `license_access_status(code, hours default 96)` | **New, read-only** (stable). Returns `active`, `completion` (with an end time), `ended` or `not_found`, plus counts. Stores nothing. | The four-day rule (section 3). |
| 9 | Privileges | The three functions are security definer with a pinned search path; anon, authenticated and public cannot execute them; service_role can. | Same lock-down as every other billing function. |

**Not changed:** `licenses` and every balance; `consume_tailor_use` and `refund_tailor_use` (Tailor); `release_license_use`; `finish_redelivery`; `result_recovery` and its 24-hour rule; the purge job; scoring; the integrity guard; any AI prompt.

## 2. How the included Polish is protected

### 2.1 Duplicate use (Verified by tests)
- **Claimed only at commit**, never at reserve, inside the same transaction that stores the recovery copy, under the existing license row lock. The claim succeeds only if the Analyze belongs to the same code, is paid, and is still unclaimed.
- **Two simultaneous commits** that both try produce exactly one winner; the other gets `included_gone`, writes nothing and charges nothing. The unique index independently refuses a second claim.
- **Two live attempts never hold the same credit**: a second request does not receive a credit that a live reservation already holds. A lapsed lease frees it again.
- **A repeat of the same request** (same request id and input) is answered `replay` with the same paid step, and uses nothing more.
- **A credit cannot cross codes**, and only a Polish may use one (an Analyze that tries is refused before anything changes).
- **Never expires** (a 400-day-old credit still works). **Works at 0 generations** and then the code is closed to AI again.

### 2.2 Unexpected charges (Verified at database level)
- A failed, unchanged or insignificant result is **released** by the application exactly as today, so the credit is never touched.
- A normal step cannot reach the included path: `p_allow_included` defaults to false, and Analyze never sends it.
- The failure budget still applies: after six costly failures an included attempt is `throttled` like any other, and the credit is intact afterwards.
- At zero generations with no credit, a step is refused even if it asks.
- A crash cannot half-apply: the claim, the commit and the recovery copy are one transaction.

### 2.3 What the database cannot do alone (Proposed, application stage, **required before launch**)
1. Send `p_allow_included` on every Polish, and send an `expectIncluded` flag from the page. If the page showed "included" but no credit exists, answer 409 and charge nothing, so an included Polish is **never silently turned into a paid one**.
2. Always commit an included reservation through `commit_license_use_with_result`. Committing it through the old `commit_license_use` would take a generation, so the application tests must cover this path.
3. Re-issue the Tailor token for the **parent Analyze**, never for the included Polish, so no extra Tailor runs appear.
4. Handle the repeat, redelivery and restored-result paths: they currently assume a paid result.
5. Bump the page guard version so tabs opened before the update must refresh.

## 3. The four-day completion policy

**Does it change the migration?** Only by one read-only function. The period is **derived**, not stored: it is the newest committed paid step plus 96 hours, and only while the code has no generations and no unused credit. Nothing has to start a clock, so it is right for every path (the last generation, the last included Polish, an admin top-up). Older codes with no recorded step fall back to `licenses.last_used_at`; a code with neither is `ended`. It is in 05 because it depends on the new columns and adds no table, column or stored data. A separate migration is **not** needed unless a resume vault is approved.

**Verified:** `active` while generations or an unused credit remain (no end date); `completion` for 96 hours after the last benefit, with no AI of any kind granted (reserve still refuses); `ended` afterwards; a top-up restores `active`; the length is a parameter.

**Proposed (application):**
- `verify-license` accepts `completion` and returns the end time.
- `export-resume` must enforce the state. Today it allows any existing code, and `tests/functions/export.test.js` asserts downloads still work after all five generations are used, so that test must change with the policy.
- The page shows the countdown and the reminder to download and save the resume.
- Customers who reached zero more than 96 hours before deployment are `ended` at once. They are already locked out of the sign-in screen today (Verified by a free browser test), so this is no worse than now.

**Does it affect the existing 24-hour recovery?** No. `result_recovery` keeps its 24-hour database rule, hourly purge and three-newest limit. The included Polish is stored there like any other paid step.

**Can the complete resume be recovered for four days? No (Verified).**

| What | Where it lives | How long | Across devices |
|---|---|---|---|
| The AI's Analyze or Polish result, as it finished | `result_recovery`, encrypted | 24 hours maximum (a table rule) | Yes, with the access code |
| The edited resume, template, pasted original, "restore my wording" copies | The browser's own draft (`fg_draft_v2`) | 14 days | **No**, never uploaded |
| The access code | The browser tab | Until the tab closes | No |
| Edits made after an AI step; Tailor results | Browser only / nowhere | | |

Four-day sign-in and download access is supported. Four-day recovery on another device, after clearing the browser, or after 24 hours, is not. Safe wording: *"You can keep editing and downloading for 4 days after your last AI step. Please download your resume and save it somewhere safe, such as your computer or a USB drive. Your draft is kept only in this browser, on this device."*

True four-day recovery would need (not included; needs your approval first): server-side encrypted storage of the whole edited resume (a new table or a relaxed 24-hour rule, a schema and retention change); a save endpoint called as the customer edits, with limits; a privacy and retention decision about holding more personal data longer, plus FAQ wording; and new tests. Recommendation: do not do this before launch.

## 4. Accepting or rejecting a polished resume

**Verified in `wizard.js` and `index.html`:**
- There is **no preview before applying.** When the server returns a meaningful result, the page replaces the resume at once. The generation (or the included Polish) was committed first.
- The customer can **reject afterwards**: "Restore my wording" for one part, "Restore all my original wording", and "Restore what I wrote before the first polish". The originals are kept in the browser draft (so they survive a refresh on that device for up to 14 days). Restoring a saved result also keeps an undo.
- **Rejecting gives nothing back**, which matches the approved policy.
- **Gap:** if a Polish is restored from the 24-hour recovery copy on a device with nothing on screen, no original exists to go back to (`index.html:665`). The server never keeps the customer's original text, by design.

**Minimum changes (Proposed, wording only, no new interface):** the confirmation before a Polish and the result message should say the included Polish or generation stays used even if the customer restores their own wording.

## 5. Test results (local PostgreSQL only; no AI, no Supabase)

### 5.1 New suite: `tests/db/included-polish.test.js`: 17 of 17 pass (16 checks plus the suite)
Additive and rerunnable; kind and credit rules; only a Polish that asks; claim without lowering the balance; zero generations; failures, lapsed lease and release; the failure budget; simultaneous commits; repeats; scope; only a Polish may use it; never expires; the 96-hour states; calls the deployed builds make; privileges; rollback and re-apply.

### 5.2 Older suites without 05 (baseline) and layered on top of 05 (`WITH_MIG5=1`)
| Suite | Without 05 | On top of 05 |
|---|---|---|
| reservations | 40 / 40 | 4 checks differ (below) |
| result-recovery (database) | 8 / 8 | 8 / 8 |
| migration03-review | 9 / 9 | 9 / 9 |
| migration04-verification | 7 / 7 | 4 of 6 checks differ (below) |
| backup-safeguards, backup-restore | 15 / 15, 6 / 6 | 15 / 15, 6 / 6 |
| Function suites (current application code against the database): polish 42, beginner-polish 13, durable-idempotency 24, result-recovery 24, live-replay 5, collective-charge 21, endpoints 40, export 17, analyze-guard 14, release-matrix 47, stress-matrix 22 | all pass* | all pass, identical counts |
| compat-matrix | 5 / 5 | 2 checks differ (below) |

\* stress-matrix showed 2 failures once in the first baseline run, while several suites were running at the same time. Run alone it passes 22 of 22, so that was load, not 05.

### 5.3 Are any differences genuine regressions? **No.**
| Difference | Cause | Verdict |
|---|---|---|
| reservations #6 and #39 | Privilege checks name the **7-argument** reserve, which 05 deliberately replaces | Expected |
| reservations #5 and migration04-verification #4 | "Apply 04 twice": re-running 04 after 05 stops with "cannot change return type of existing function"; the transaction rolls back and nothing is damaged | Expected; do not re-run 04 after 05 |
| reservations #34 | "`schema.sql` equals the migrations": the fresh-install snapshot does not include 05 | Expected; update `schema.sql` is deferred |
| migration04-verification #1 to #3 | The 04 pre-check and post-check SQL look for the 7-argument reserve | Expected; after 05 use the 05 post-check |
| compat-matrix (2 checks) | The suite builds a "03 rolled back" state by running the 03 rollback **after** 05 was layered in, which leaves two reserve versions | Rollback-order rule, not a defect (see section 6) |

Each cause was confirmed by reading the failing assertion, not assumed. The behaviour-level suites (billing, replay, recovery, export, Polish, stress) are unchanged.

## 6. Pre-check, post-check, rollback and compatibility

**Pre-check (`docs/MIGRATION_05_PREFLIGHT.sql`, read-only):** reports the database state (expect "E: migrations 03 and 04 applied, 05 not applied"), prerequisites, name collisions, the exact function versions, live reservations, a balance fingerprint to keep, balance sanity and privileges. Verified locally inside a read-only transaction; it reports "F: already applied" afterwards.

**Post-check (`docs/MIGRATION_05_POSTCHECK.sql`, read-only):** one-row verdict PASS or a named FAIL (columns, the unique index, exactly one 8-argument reserve, privileges, earlier functions and `result_recovery` intact, claims consistent, balances in range), then the fingerprint, which must equal the pre-check value. Verified locally: PASS. The 04 post-check reports FAIL after 05 by design.

**Rollback (`supabase/rollback/20261027_05_rollback.sql`):** returns the database to the state after 04, using the exact function text copied from the 03 and 04 files. It keeps every row and the three inert columns, so no used or unused credit is lost and re-applying 05 later needs no data migration. Verified: the 7-argument reserve and the old result shape come back, privileges are closed, balances are identical, and 05 re-applies cleanly. **Order:** redeploy the previous build first. **Roll back in reverse only: 05, then 04, then 03.** After a rollback an unused credit cannot be used until 05 is applied again.

**Application compatibility (Verified at the SQL level with the exact named arguments each build uses; the release-candidate code was also run against a 05 database in the function suites):**

| Build | Calls | Effect |
|---|---|---|
| Published `0a1a014` | `reserve_license_use` with 5 named arguments, `commit_license_use`, release, Tailor | Works unchanged. It never asks for an included Polish and never records `kind`, so its Analyzes earn no credit. |
| Release candidate `60073993` | reserve with 7 named arguments, `commit_license_use_with_result` | Works unchanged. Its Analyze commits record `kind`, so they earn credits it cannot yet use. They stay available, because credits do not expire. |
| Future build | sends `p_allow_included` | Requires 05 first; against a database without it, it fails safely (503, nothing charged). |

**Apply order:** fresh backup, pre-check, migration 05, post-check, then deploy the application build.

## 7. Risks that remain before production

| # | Risk | Severity | How it is handled or what is needed |
|---|---|---|---|
| 1 | An included Polish committed through the wrong function would take a generation | High if missed | Application rule 2.2 and a test that fails on it. Not a database issue |
| 2 | A paid Polish could be charged when the page promised "included" but the credit is gone | Medium | `expectIncluded` 409 guard (2.3) |
| 3 | The application stage is not built: until it ships, customers see no change and credits cannot be used | Planned | Separate assignment after you approve this package |
| 4 | Download enforcement for the four-day rule needs `export-resume`, `verify-license` and one existing test changed | Medium | Application stage |
| 5 | Four-day recovery cannot be promised | Wording risk | Use the safe wording above in the page and the Etsy FAQ |
| 6 | The migration replaces the two central billing functions | Medium | Backup, pre-check, post-check, rollback, quiet moment (no live reservation), migration before deploy |
| 7 | I could not see production. The pre-check assumes state E (as the handoff states) | Low | The owner runs the pre-check first and stops if it says anything else |
| 8 | `licenses.last_used_at` fallback: the Etsy Apps Script lives outside this repository, so I could not confirm it never writes that column | Low | Only affects codes with no recorded step; the post-check does not depend on it |
| 9 | Loophole: Analyze a short text, then spend the included Polish on a large resume | Accepted | Bounded cost of roughly $0.13 (an estimate); shared codes share credits, as they already share generations |
| 10 | Rolling back out of order leaves two reserve versions | Operational | Document: reverse order only; keep the rollback files together |
| 11 | `schema.sql` does not include 05 | Low | Deferred; fresh installs apply the migrations in order |
| 12 | Brief table locks when adding columns and indexes | Low | The table is small; the whole migration is one transaction |

## 8. Differences from the earlier (Opus) recommendations

- The 30-day expiry was removed (founder decision): credits never expire.
- The separate `included_polish_status` function was merged into one read-only `license_access_status`, which also carries the four-day state.
- The four-day period is derived from the last committed step rather than stored.
- The Tailor database backstop was dropped; the application re-issues the parent Analyze's token instead.
- An extra guard, the unique index on `included_polish_by`, was added.
- The credit is chosen oldest-first on the server, and the application never has to name one.

## 9. Approval points before any production step

1. Your review of this package and the SQL (this stage ends here).
2. Decision on four-day recovery: launch with the reminder wording only (recommended), or approve a separate storage design first.
3. Permission to push the branch (no pull request or merge yet).
4. The owner takes a fresh backup, runs the pre-check, applies 05, runs the post-check.
5. A fresh isolated test license is created by the owner (not created yet).
6. The application stage, as a separate assignment.
