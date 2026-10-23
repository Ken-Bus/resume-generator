# Writing-quality, factual-integrity and charging stress test (2026-10-23)

Scope: one pass on `feature/guided-resume-and-export-fixes`. Fictional data, local Postgres, mocked AI, real Chromium. No paid Anthropic call, no personal generation spent, no customer data, nothing merged or deployed, no production migration, Etsy and Founder OS untouched. Guard version is now `entry-scope-withhold-4`.

## 1. Personas and scenarios
Ten applicants (`tests/functions/personas.js`): minimal first-timer; detailed first-timer (school, projects, volunteering); 20-year warehouse worker; career changer; returning after a long gap; several jobs + projects + certifications; sparse and badly written (typos, lower case); already well written; long resume at the application limit; incomplete / inconsistent / ambiguous (blank title, end before start, duplicate bullets, "various duties").

AI behaviours (22), each judged by an independent oracle: unchanged; capitals/punctuation; filler word; one-word synonym; one word from the same entry; re-ordered lists; one-word grammar fix; several grammar fixes; real rewrite; merged bullets; clearing up a confusing line; removing a duplicate; invented number / leadership / beneficiary / outcome / filled blank / invented job and skill; line borrowed from another entry; good + bad together; everything rejected; hostile shapes. **165 applicant x behaviour scenarios, 0 violations** on the real build.

Customer-change scenarios (database-backed): adds responsibilities and measurable achievements; AI "corrects" a number; adds another job; removes a job (stale reply replays it); changes a title and dates; gives only vague information; polishes, edits, polishes again; repeats polish without changes (replay, then the free-attempt cap); failures and retries; 8-way concurrency (12 rounds); long resume at and over the limit; log privacy across a mixed run.

System flows (Chromium, desktop 1280 and Android 360 wide): Paste -> Analyze -> Polish -> Edit Fields -> PDF and Word -> Restore part -> Restore all; Guided Builder typing -> polish free -> polish charged -> Restore; Polish -> Tailor -> edit after tailoring -> Polish again; double-click and overlapping AI steps; the one-word touch-up case on both screens.

Tests that prove the tests can fail: the same oracle is run against five deliberately broken builds (guard off, every change charged, nothing charged, flagged lines kept as in 884640f, no entry scope); each is caught (59 / 12 / 8 / 59 / 19 violations). The browser journey is likewise run against a guard-less simulated server and a server that charges one-word edits; both are caught.

## 2. Problems found and root causes
| # | Problem | Root cause | Severity |
|---|---|---|---|
| 1 | A one-word edit ("donated") cost a generation | `assessChange` counted any changed line as "reworded" | Owner-reported |
| 2 | **Deleting a duplicate bullet in the middle of a list was charged**; re-ordering a list or skills was charged | Lines were compared by POSITION, so every line after a deletion looked rewritten | High (billing correctness) |
| 3 | **Two AI calls could run at once for one code** (about half of runs of the existing concurrency test failed, also on the previous commit) | "Am I the earliest reservation?" used `created_at`, which is the START time of the inserting transaction; a request that waited on the row lock is stamped earlier than one that was inserted first, so both believed they were first | High (a double click could cost two AI calls / two charges) |
| 4 | **Subtle single-fact inventions passed the guard** ("... and reported discrepancies", "... for families in need", "... against invoices", "...for the school pantry", 9 of 25 plausible inventions) | The guard needed TWO new content words in a line | High (factual integrity) |
| 5 | Stemmer gaps: "organized" did not match "organize"; "orders" vs "order"; "used" vs "use" | Inconsistent suffix stripping and a plain-verb list compared in the wrong form | Medium (false flags once 4 was fixed) |
| 6 | Test mocks were too accommodating: the default "faithful reword" appended "and more", and fixtures treated new nouns ("coworkers", "pantry staff", "before shipping") as honest | Mock quality | Process |

## 3. Corrections implemented
1. `classifyEdit` / `assessChange`: cosmetic | minor | rewrite by the SHAPE of the edit (see `docs/MEANINGFUL_IMPROVEMENT_POLICY.md`); lines matched by content within their group; `minor` reported separately; reply `reason: "minor"` with its own message and card; prompt rule 11.
2. `_lib/inflight.js`: at most one request proceeds; the earliest waits briefly and goes only if the others are gone.
3. Guard: in AI Polish one new content word that the entry never used is a reason to withhold the line (spelling corrections of the customer's own words are exempt); function-word list extended; stemmer made consistent; neutral action verbs added. Honest rewrites kept: 18 of 20 in the corpus (the 2 withheld are harmless adjectives, listed as known limits); inventions caught: 22 of 22 (2 in-entry words pass by design).
4. Tests: realistic mocks (`realReword`), personas, stress matrix, guard corpus, edit table, in-flight unit tests, Chromium system flows. Fixtures that wrongly treated new nouns as honest were corrected.
Unchanged: price, five generations, Tailor allowance, licensing, export, security headers, database schema.

## 4. Test counts
Full suite with database-backed tests enabled: **426 tests, 426 pass, 0 fail, 0 skipped** (about 290 s). Before this pass: 382. New: stress matrix (21), guard corpus (3), edit classification (4), in-flight (5), Chromium system stress (10), and updated fixtures. The concurrency test that failed about half the time passes 9 of 9 runs after the fix, and the old code fails the new 12-round loop 3 of 3.

## 5. Meaningful-improvement and charging findings
- Rule now: charge only for a REWRITE (two or more separate edits, restructure, several words replaced, a new line). Not charged: capitals/punctuation, re-ordering, one word added/removed/swapped, filler-only, deletions, all-withheld, unchanged, any failure.
- The live case ("food for pickup" -> "donated food for pickup", plus the two invented lines) is now free and applies nothing.
- Limits of ANY deterministic rule (documented, not hidden): a genuinely useful one-word fix is free; a two-word addition of little value is charged. One optional stricter proposal ("insertion-only edits are never charged") is written up with tradeoffs; recommendation: not now.
- Charging mechanics verified under failures, retries, replays, caps and 8-way concurrency: exactly one charge per accepted rewrite, none otherwise; reservations never left held.

## 6. Remaining risks, ranked
1. **High: still nothing run against the live model with these rules.** Real Sonnet output decides how often honest lines are withheld (stricter guard) and how often results are free. Mitigation: one owner run, read the `ai-outcome` line (`reworded`, `withheld`).
2. **Medium-high: helpfulness vs strictness.** One unfamiliar word withholds a line; some honest improvements will be lost (two known harmless adjectives in the corpus). Lines withheld cost the customer nothing, but a mostly-withheld result looks like "no improvement".
3. Medium: long-resume timing unmeasured (limits are arithmetic). 
4. Medium: headers/404 rules untested on a real Netlify deploy and on Safari/iOS/Firefox.
5. Low-medium: per-instance limiters (free-attempt cap etc.); durable version proposed, not applied.
6. Low: the settle wait (150 ms) means a rare near-simultaneous pair can both be told "busy"; the customer retries, nothing is charged.
7. Low: `check-code-supply` possibly public; `consume-generation` shim.
8. Known facts about pattern-based checks: new nouns already present in the same entry pass by design.

## 7. Release recommendation
**Not yet; ready for the final owner acceptance run.** The defects found here (billing by position, double AI calls, weak guard) are fixed and covered, and the system is better than before this pass. The one thing automated tests cannot establish is how the real model behaves under the stricter rules and the new "rewrite" definition. Release after the checks below pass; if the live run shows many honest lines withheld, loosen only the one-new-word rule (a single-line change guarded by `tests/functions/guard-corpus.test.js`).

## 8. Minimum owner-only acceptance checks
1. Netlify: branch deploy at this commit is Published. Open `/.netlify/functions/polish-resume` in a browser: `"version":"entry-scope-withhold-4"`; Console `ResumeCore.GUARD_VERSION` the same (free).
2. `SETUP.md` 5b publication/header commands; page loads with no console security messages; one phone pass (free).
3. ONE generation, personal licence, fictional Taylor Rivera: Polish. Pass = no invented claim anywhere; the card lists what was left out; the counter drops by 1 only if some line was truly rewritten, otherwise it stays and the card says so; the Netlify `ai-outcome` line shows `"guard":"entry-scope-withhold-4"`.
4. Download PDF and Word of the result (free): text matches the screen.
