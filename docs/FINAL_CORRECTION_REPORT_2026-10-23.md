# Final Correction, Customer Protection & Release Readiness Report (2026-10-23)

Branch `feature/guided-resume-and-export-fixes`, starting commit `b6884f3` (verified clean and in sync before work began), final pushed commit `67e6a53`. Fictional data only. No paid Anthropic call, no production change, no merge, no deployment, no Etsy change, Founder OS not touched.

## 1. Executive summary: **CONDITIONALLY READY. Not releasable until three owner-only steps pass (section 14).**

What changed since the last report: the biggest open risk (a lost reply retried on another server instance could charge twice) is **fixed in code and proven against real local PostgreSQL**, but the fix needs a database migration that only the owner may approve and apply (`supabase/migrations/20261023_03_request_idempotency.sql`, **not applied anywhere**). Until it is applied, the new code answers a request that carries a request id with a calm "try again" and charges nothing; the old behaviour is not lost, it is just not yet durable.

What still blocks an unconditional READY, all outside what I was allowed to do:
1. Migration 03 must be approved and applied, in the order in `docs/MIGRATION_03_DEPLOYMENT.md`.
2. The real model (Sonnet 5.5) has never been run. Every writing-quality figure in this report is from simulated model answers. One authorized personal-code generation is needed.
3. Nothing has been verified on a deployed site or a physical phone (headers, real timing, real Android/iOS).

Everything that can be proven locally passes: **554 of 554 tests, 0 failed, 0 skipped.**

## 2. Defects corrected in this assignment, with root cause

| # | Finding | Root cause | Status |
|---|---|---|---|
| 1 | Duplicate charge when a lost reply is retried on another or restarted instance (HIGH) | Repeat protection lived in one instance's memory | **Fixed**: database-backed request key + input hash, `replay` outcome, bounded re-delivery. Needs migration 03 |
| 2 | A repeat could be matched to a different code's paid step | (design check) | Key lookup is scoped to the code; tested, mutation-tested |
| 3 | A stale result could be applied if the customer edited text between tries | (design check) | Key is bound to an input hash; changed text is a new step |
| 4 | Provider overload (429/503/529) was reported as a generic failure | One catch-all message | Calm "very busy, wait a minute" message on Analyze, Polish and Tailor; no server-side retry loop; not counted as the customer's failure |
| 5 | "Managed the freezer section" accepted for "worked in the freezer section" when the entry mentioned "the manager" (reproducible unsupported claim) | The word "manager" (another person) counted as support for the customer's own leadership claim | **Fixed**: another person's role never supports or creates a claim. Found by the fresh holdout |
| 6 | "led" matched inside "ledger" | Root match without a word boundary for 3-letter roots | Fixed |
| 7 | Honest edits rejected: "pick up" to "pickup", a misspelled duty word corrected ("orgenized" to "organized"), everyday equivalents (garbage/trash, mad/angry, older/elderly, own/personal, many/alot, watch/monitor, schedule/book) | Joined words ignored short words; spelling fixes of duty words read as new duties; no everyday-equivalent entries | Fixed as rules, not per-case patches |
| 8 | Polish prompt allowed synonym swaps the guard then had to reject | Prompt and guard disagreed | Prompt now says: reuse the customer's own words, change a word only to correct it or replace a vague one |
| 9 | Test gaps: Polish guess limit (mutation N08) and spelling salvage (N12) survived; double-submit, offline typing and back/forward had no test | Missing tests | Added; mutations re-introduced and caught |
| 10 | A flaky simultaneous-request test (about 1 run in 6) | The test's 150 ms AI delay was shorter than cold connection setup, so a legitimately later request was a new, sequential request | Root-caused (not rerun until green); delay raised to 700 ms; 10 consecutive clean runs |

Fixed earlier in this campaign and still verified by the suite: Analyze double charge, lost work on reload, page dying when storage is blocked, code-guess oracles, stemmer and guard accuracy, silent UI skips, misleading timeout and "already clear" messages, 22 items in all (see `docs/QA_FINAL_REPORT_2026-10-23.md`).

## 3. Remaining defects and limits, ranked

| Rank | Item | Customer impact |
|---|---|---|
| 1 | **Real-model writing quality unverified** | Unknown how often the real model's edits pass the guard; the guard is deliberately strict |
| 2 | **Migration 03 not applied** | Until applied, the lost-reply protection is the old in-memory one |
| 3 | Guard rejects about half of natural, faithful rewordings (see section 9) | A customer may get "nothing to apply" and keep their own wording, never an unsafe line. Owner decision whether a stricter or looser trade is wanted |
| 4 | Deployed environment unverified (headers, cold start, long-resume timing) | Unknown |
| 5 | Physical devices unverified | Real keyboards, tab discard and downloads on Android/iOS untested |
| 6 | Tailor lost reply can use one of the five tailoring runs | Low: tailoring never uses a generation; the allowance is unchanged |
| 7 | Per-instance guess limiter | Best effort across instances; the code space (31^8) makes guessing impractical |
| 8 | Not fixed, disclosed: Analyze copies text verbatim; fact fields (titles, schools) are never spell-corrected; dates and contradictions are not flagged; a lone 5,000+ character token loses its tail in the PDF; a lead-verb typo ("cary") is not salvaged when a line is withheld | Minor |

## 4. Implemented fair-charging behaviour (verified locally)

3 points or more: improvements applied, exactly one generation charged, updated balance returned. Under 3: improvements are not handed out, the customer's wording stays, the reservation is released, nothing is charged, and the message explains it. The same fix is never counted twice (a correction repeated on five lines is one point); rejected material earns nothing; a removed repeat counts only if the AI itself removed it; failures and unusable results never charge; the free-attempt cap and failure budgets are kept; five generations, $11 and the Tailor allowance are unchanged. Evidence: `scoring.test.js`, `collective-charge.test.js` (14 tests, real SQL), stress matrix (oracle, 10 applicants by 22 AI behaviours).

Wording note for the owner: the instruction says to "apply the accepted improvements" below 3 points. The implemented rule (the one approved earlier) keeps the customer's wording below 3. Applying them free would give the polish away below the threshold; I kept the approved behaviour and the customer message says exactly this. If you want sub-3 improvements applied free, that is a one-line change plus a pricing decision (an Opus topic).

## 5. Durable billing and retry evidence (real local PostgreSQL 16, independent simulated instances)

`functions/durable-idempotency.test.js` (14 tests) and `db/reservations.test.js` (38 tests). "Instance" means freshly loaded handlers with empty memory and their own connection pool.

| Scenario | Result |
|---|---|
| Analyze charged on A, reply lost, retry on cold B (same request id) | One charge, result re-delivered, tailor token valid |
| Polish, restart (new pool, empty memory) | One charge, same fixes delivered, tailoring still works |
| Different request id, or text edited, or another code | New step (charged as normal), never a stale or foreign result |
| Re-delivery fails (AI outage) | 502, nothing charged, its turn is given back, next retry works |
| Five simultaneous retries across cold instances | Exactly one re-delivery runs, the rest told to wait, no extra charge |
| Fourth re-delivery | Clear "message us" notice, no AI call, no charge; an exhausted code still re-delivers its paid step |
| Original still running on A when the browser retries on B | B turned away uncharged; safe re-delivery afterwards |
| Below-threshold (free) polish retried elsewhere | Ordinary free attempt, never charged |
| Page without request ids (older page) | Behaviour unchanged, no key stored |
| New code, database without migration 03 | 503 "try again", nothing charged; request without an id still works |
| Provider 429/529 | One provider call per request, calm message, nothing charged or counted against the customer |
| Privacy | Database holds only two SHA-256 hashes; no request id, name or resume text; logs carry none either |
| Migration applied twice; 5-argument call from the deployed code | Works; license rows untouched; server-only privileges; one function overload only |

Mutation evidence for this code: 16 mutations, 12 killed; 3 survivors are equivalent (a forced second commit is a no-op because `commit_license_use` is idempotent; the one-at-a-time check finds no reserved rows during a re-delivery; the double-submit guard in the client is backed by `aiBusy` and its only visible effect is a transient message that the finished result replaces). Guard changes: 6 mutations, 5 killed, 1 equivalent ("led" inside "ledger" is also caught by another check).

## 6. Customer-work preservation (Chromium, mocked endpoints)

Verified by `ui/work-safety.test.js` (15 tests) plus existing suites: refresh and return; reload mid-polish reuses the same request id; storage blocked; damaged saved copy ignored; two polishes keep the customer's original one click away; leaving page asks first; "clear this saved copy"; **new:** offline typing then reload, browser Back/Forward, same-instant double submit (one request, no error message). Guided/Edit switching, template changes, add/delete/reorder with Restore, edit after Polish or Tailor are covered by `guided`, `release-hardening`, `access-polish` and `stress-system` suites. The access code and the saved resume stay in tab-scoped sessionStorage only (never localStorage, never logged); that is readable by scripts on the page, which has no third-party scripts and a strict CSP. Best effort, not guaranteed.

## 7. Error handling

Anthropic outage, rate limit and overload, timeout, truncated, malformed and refused answers, Supabase failure, oversized input, stale deployment, duplicate requests, exhausted and invalid license, export failure, offline: each has a test showing the error is detected, work is kept, accounting is right, the message is plain, and the customer can retry. No automatic retry loops exist on the client or the server (one provider call per request is asserted).

## 8. Security, privacy and authorization

Verified: paid endpoints and exports need a valid code; per-client guess limits on verify, export, Analyze, Polish and consume; only five files are public and function source, SQL and docs return 404; security headers and CSP tested with the headers enforced in Chromium; hostile text is shown literally; prompt-injection answers are guarded; logs carry no resume text, codes, emails or secrets; `npm audit --omit=dev` reports 0 vulnerabilities. Best effort, not guaranteed: the guess limiter is per server instance; the factual guard is pattern-based; sessionStorage is script-readable. Not verified: headers on the real deployed site.

## 9. Writing quality and authentic voice

**Simulated-model results only; none of this is evidence about the real Sonnet 5.5.**

Thirteen fictional applicants (first-time and high-school job seekers, retail, warehouse, career changer, gap, severe typos, extensive history, already-clear, incomplete, near-limit) by three simulated answers: careful editor charged 10 of 13, natural LLM-style 10 of 13, over-eager inflated **0 of 13**, inflation reaching an accepted resume **0**, no duty lost. Full before/after resumes: `docs/QA_ROUND3_OUTCOMES_2026-10-23.md` (regenerated from the final code).

Two independent holdout corpora (written by separate subagents that never saw the code):

| Corpus | Honest edits kept | Dishonest edits leaked | Natural faithful lines kept | Natural reach / invented leaked |
|---|---|---|---|---|
| Holdout 1 (tuned on earlier; **not independent any more**) | 79 of 84 | 0 of 56 | 71 of 131 | 1 of 48 / 0 of 2 |
| **Holdout 2, first pass, before any change** | 88 of 120 (73%) | **1 of 72** | 45 of 91 | 1 of 28 / 0 of 23 |
| Holdout 2, after fixing root causes (**tuned, no longer independent**) | 99 of 120 (83%) | 0 of 72 | 47 of 91 | 1 of 28 / 0 of 23 |

Honest reading: the guard never let a new number, tool or credential through, and on the fresh corpus it let one role upgrade through before the fix. It rejects roughly half of natural, plausible rewordings that swap one everyday word for another ("took money" to "took payments", "watched kids" to "cared for kids"). Those need meaning judgement a deterministic check cannot make safely, so they are kept as the customer's own wording, never invented. The one remaining leaked "reach" line adds reporting to administration. The prompt now steers the model to the customer's own words, which should lift acceptance with the real model; that is a prediction, not a measurement.

## 10. Test results (exact)

`cd tests && node run-release.js`: **554 passed, 0 failed, 0 skipped, 0 cancelled, of 554.** By area: core 12, db 38, functions 357, ui 147. The runner fails on any skip and `REQUIRE_BROWSER=1` fails if no Chromium is found. The baseline of 463 grew by 91 tests across this campaign. No unexplained skips.

Suites covered: unit, real-SQL billing and concurrency, API integration, retry/restart/lost-reply, fault injection, factual-integrity adversarial, desktop Chromium journeys, an Android-profile journey (360x740, touch, mobile), phone viewports 375x667 and 320x568, all 12 templates for PDF and Word, customer-error recovery, security and authorization, log privacy, build-version compatibility. A final diff review (`git diff b6884f3..HEAD`) found no debug statements, `.only`, secrets or leftover scratch code.

## 11. Database migration

`supabase/migrations/20261023_03_request_idempotency.sql`, mirrored in `supabase/schema.sql`. **Not applied to any database other than disposable local test databases. Needs the owner's approval.** Order, compatibility with the deployed code, backup, rollback and customer-impact risks: `docs/MIGRATION_03_DEPLOYMENT.md`. Summary: back up, apply migration 03 (additive, one transaction, idempotent), verify one `reserve_license_use` function, deploy the branch. The currently deployed code keeps working against the migrated database; code rollback is a plain redeploy; database rollback is dropping the 7-argument function and re-running migration 01.

## 12. Verified vs simulated vs not verified

| Label | Covers |
|---|---|
| Verified local behaviour | All of sections 5, 6, 7, 8, 10: real handlers, real PostgreSQL, real SQL migrations, real Chromium (desktop and Android profile), real PDF and Word generation |
| Simulated Anthropic | Every AI answer in every test and in section 9 |
| Real Anthropic API | **Nothing** |
| Live Netlify | **Nothing** |
| Physical devices | **Nothing** |
| Unverified assumptions | Real latency and cost per generation; that the real model follows the new "own words" prompt rule; that sessionStorage behaves the same in every in-app browser |

## 13. Marketing and copy

`docs/ETSY_FAQ_AI_POLISH.md` (draft, **not published**) now describes the lost-reply protection ("about an hour"), the very-busy message and the 3-point rule. Its "about an hour" claim is true only after migration 03 is live; the file says so. Claims still to avoid: ATS-friendly or optimized, guaranteed interviews, "never makes mistakes", naming the AI model, presenting the free sample (a fictional senior retail executive) as AI output.

## 14. Smallest owner-only checklist

1. **Approve and apply migration 03** (steps in `docs/MIGRATION_03_DEPLOYMENT.md`), then merge and deploy by your normal process.
2. **One paid generation** on a personal test code with a fictional resume: confirm the result reads in the customer's voice and the charge or no-charge outcome is right. (Authorization needed; I did not do it.)
3. **Phone pass** on one Android and one iPhone: build, refresh mid-way, polish, download PDF and Word.
Optional, lower priority: long-resume timing on the deployed site; review the FAQ draft before it goes on Etsy; decide whether sub-3-point improvements should be applied free (section 4).

## 15. Commits and files

Commits this assignment: `4b5acf4` durable idempotency; `24a0ed4` provider-busy message, work-safety tests, FAQ and setup notes; `67e6a53` guard fixes from the fresh holdout and prompt alignment (plus this report). Main files: `supabase/migrations/20261023_03_request_idempotency.sql`, `supabase/schema.sql`, `netlify/functions/{parse-resume,polish-resume,tailor-resume}.js`, `_lib/{license,replay,ai,usage,integrity}.js`, tests (`durable-idempotency`, `reservations`, `work-safety`, `guard-accuracy`, harness and README), `docs/MIGRATION_03_DEPLOYMENT.md`, `docs/ETSY_FAQ_AI_POLISH.md`, `SETUP.md`.

## 16. Restrictions observed

Production Supabase and Netlify untouched, no deployment, no merge to main, no pull request, no live Etsy change, no paid Anthropic call, no real customer data, license or secret, pricing and entitlements unchanged, only `Ken-Bus/resume-generator` on the authorized branch was changed. Founder OS was not read, edited, committed or pushed in this assignment. (Earlier in the session, before this assignment, a read-only directory listing and `git status` were run in the Founder OS folder; nothing was changed.) The session remains open: no recap and no Founder OS update until you close it. Two subagents wrote fictional holdout corpora; their independence limits are stated in section 9.
