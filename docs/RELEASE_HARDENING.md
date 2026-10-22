# Release hardening pass (branch `feature/guided-resume-and-export-fixes`, from commit 884640f)

**Status:** implemented and tested locally; **not merged, not deployed, no paid AI call has been made.** Everything below marked "owner check" needs the branch deploy.

## Findings, in priority order

| # | Finding | Severity | Evidence | Fix |
|---|---|---|---|---|
| B1 | Analyze, AI Polish and Tailor could overlap; the slower answer overwrote the faster one (a paid result thrown away, wrong counter), and typing during a step was overwritten | Release-blocking | Chromium reproduction | One AI step at a time: other buttons disabled, fields frozen (`inert`), released in `finally`; 75 s client timeout so a stalled phone connection cannot freeze the editor |
| B2 | "Restore my wording" restored by position: after the customer deleted an earlier entry it put the first project's bullet into the second | Release-blocking | Chromium reproduction | Entries are matched by name/title; an entry that cannot be matched is left alone; Restore asks before discarding later edits; Restore-all also clears the stale "Undo tailoring" |
| B3 | Tailor had none of the new entry-scoped protections | Owner decision 2 | Code review | Same guard as Polish (`guardResume`, mode `tailor`) on the cleaned resume; flagged lines are put back; matched-keyword list is checked against the result |
| B4 | A polish whose only changes were flagged was still charged | Owner decision 3 | Code review | Only the ACCEPTED result is charged; all-withheld = released uncounted (see `docs/AI_POLISH.md`); capped separately; the AI's rejected text is never returned |
| B5 | The whole repository root was downloadable (function source and prompts, SQL, scripts, tests, docs, setup notes) | Release-blocking (exposure, not a secret leak) | `publish = "."` | Forced 404 for everything except the five page files; a test fails if a new file is neither public nor blocked; new security headers incl. Content-Security-Policy |
| B6 | A non-text value from the AI (for example `{"text": ...}` as a bullet) printed "[object Object]" in the page, PDF and Word; unknown keys passed through; a hostile object could throw inside the integrity check | Release-blocking | Fuzz | Only text and plain numbers are content; output reduced to known fields; the integrity helpers cannot throw on hostile values |
| B7 | Inputs too long for the output cap spent AI money on calls certain to be cut off | Release-blocking (cost + confusing errors) | Arithmetic | Refused before any reservation or AI call (Analyze over 20,000 characters; Polish/Tailor over about 19,000 JSON characters); timeouts/truncations show a plain "too long" message |
| I1 | A line copied verbatim from another entry passed; a borrowed word needed two new words to be noticed | Important | Matrix test | Explicit "copied from another entry" check |
| I2 | Analyze output was never checked against the pasted text | Important | Code review | Invented email/phone/website/dates removed; unsupported numbers flagged |
| I3 | Analyze overwrote the customer's own work without asking; "Restore all" discarded later edits silently | Important | Chromium | Confirmations |
| I4 | Phones: inputs 11-14px (iOS zooms on focus), tap targets 12-31px | Important | Measured | 16px inputs, 40px targets (375 and 320 px wide, every builder step) |
| I5 | `verify-license` had no throttle | Important | Code review | 30 failed lookups / 10 min per client (in memory) |
| I6 | Release failure was a single attempt (a lapsed lease counts as a strike) | Important | Code review | One retry |
| I7 | Pure deletions counted as "reworded" | Important | Matrix test | Reported as `dropped`; never charged |
| I8 | Edit Fields did not highlight flagged project descriptions or job summaries | Important | Customer report | Highlighted with the "Added by AI" note |

## What was checked and found sound (no change)
Charging and reservation SQL (concurrency, crash, retries, throttling, rollback safety: 40+ database tests unchanged and green); export authorization and rendering (all 12 templates x six very different resumes, PDF and Word: every line present, selectable text, no page images, no placeholders, 30-job resume paginates); HTML/script injection is shown literally everywhere; CORS; token signing and rotation; AI usage logs contain only counts and ids.

## Decisions that were made (please correct if wrong)
- Flagged lines are **withheld** (put back to the customer's wording) rather than kept with a yellow warning. This is stricter than before and means a false positive costs the customer a suggestion; they can type it in themselves.
- Withheld suggestions are described (where, why) but their text is not returned, so a rejected suggestion cannot be collected for free.
- The free-attempt cap is per code and does not depend on the content (otherwise changing one character would reset it).
- Analyze's paste limit is now 20,000 characters (was 30,000, which could not fit the output cap).

## Release risks, ranked by severity

| Rank | Risk | Severity | Why it matters | What reduces it | Decision / owner action |
|---|---|---|---|---|---|
| 1 | **Nothing has run against the live Sonnet 5.5 with this branch's new code** (stricter Polish guard, Tailor guard, Analyze grounding, accepted-result charging). Tests use a mock that rejects what the real API rejects; the live model's wording, token use and reply shape can still surprise. | High | The only thing between the branch and a customer-visible failure is the real reply. A false-positive guard would withhold honest suggestions; a parsing surprise would show a friendly error (nothing charged). | 346 automated tests, reservation/commit/release proven in the database; every AI failure path releases uncharged. | Run checklist steps 4 to 7 (at most **one** credit, see below). |
| 2 | **Long-resume limits and timing are unmeasured.** Limits are arithmetic (about 0.385 output tokens per JSON character; Analyze 20,000 characters; Polish/Tailor about 19,000). A real 3 to 5 page resume could still time out (`AI_TIMEOUT_MS`, 75 s browser limit) or be cut off. | Medium-high | Customer sees "too long"/timeout instead of a result; nothing is charged, but it is a bad first experience for the customers with the most to improve. | Refused before any AI call when over the limits; truncation and timeouts release uncharged; `ai-usage` log records tokens and milliseconds. | Free: read `ms`/`out` from the log after any real run; calibrate before raising limits. |
| 3 | **Headers, CSP and 404 rules are untested on a real Netlify deploy and on Safari/Firefox/iOS.** | Medium | A mistake would break the page for everyone (CSP) or expose a file (404 rules). Tests prove the rules and the page under the policy in Chromium only. | Rules checked by test against every tracked file; page and downloads run in Chromium with the CSP enforced and zero violations. | Free: SETUP.md 5b commands + browser console + one phone. If the page misbehaves, delete the `Content-Security-Policy` line in `netlify.toml` and redeploy. |
| 4 | **Pattern-based integrity checks** can miss a fabricated claim written in plain words, or withhold an honest line that uses a flagged pattern. | Medium | Factual accuracy is the product promise. | Entry-scoped, deterministic, tested on a matrix; flagged lines withheld (the original text is kept); withheld text is never returned. | Accept; watch `P202` counts and any customer report. |
| 5 | **In-memory limiters are per serverless instance** (free-attempt cap, `verify-license`, export). | Low-medium | Limits are looser than stated under spread traffic; no customer-facing error, no free paid output. | All still need a valid code; failures are throttled durably in the database. | Proposal: `docs/PROPOSAL_DURABLE_FREE_ATTEMPT_CAP.md` (not applied). Recommendation: after launch. |
| 6 | **`check-code-supply` may answer anonymous URL requests** with the unassigned-code count. | Low | Information leak of a business metric; cannot read codes, cannot create unlimited codes, cannot spend AI money. | See `docs/CODE_SUPPLY_EXPOSURE.md`. | Free check; if reachable, return `{ok:true}` instead of counts. |
| 7 | **`consume-generation`** deprecated read-only shim still deployed. | Low | No charge, no data; just surface area. | - | Remove a few days after release. |

## Unavoidable owner decisions
1. Approve the paid live acceptance run (one credit), or accept risk 1 as is.
2. Merge/deploy timing (the old model retires Nov 30, 2026).
3. Optional: apply the durable-cap migration (recommended: after launch).

## Publication rules: confirmed not to block required assets, functions or downloads
Checked by reading every URL the page requests and comparing to `netlify.toml`:

| What the page needs | URL | Rule that could affect it | Result |
|---|---|---|---|
| The page | `/`, `/index.html` | none | served |
| Scripts | `/resume-core.js`, `/templates.js`, `/wizard.js` | `/templates/*` blocks the **folder** `templates/` only; it does not match `/templates.js` | served |
| Not-found page | `/404.html` | none (target of the blocking rules) | served |
| Fonts | `https://fonts.googleapis.com`, `https://fonts.gstatic.com` | external; allowed in the CSP (`style-src`, `font-src`) | allowed |
| Etsy link | `https://www.etsy.com/shop/FlexandGrace` | navigation link only, not a resource load | unaffected |
| All AI, licensing and export calls | `/.netlify/functions/*` (verify-license, parse-resume, polish-resume, tailor-resume, export-resume) | none of the rules start with `/.netlify/`; the CSP allows same-origin `connect-src` | unaffected |
| PDF / Word downloads | produced by `export-resume`, saved by the browser from a `blob:` link | `/*` headers add no download restriction; CSP does not govern a download click | unaffected (real PDF download is exercised in the Chromium test with the CSP on) |
| Delivery instruction templates | `templates/delivery-instructions.*` | blocked on purpose; only referenced as local reference copies (`SETUP.md`), nothing on the web requests them | intended |

Two automated tests keep this true: *every tracked file is public or blocked* and *the public page does not pull in anything from a blocked path*. Still untested: how a real Netlify deploy applies them (see "Checks against the deployed branch").

## What has been tested, and where

### A. Automated tests (run locally in this environment; **not** against Netlify)
`npm test` in `tests/`: **346 pass, 0 fail, 0 skipped** (about 200 s) at commit be8f9b4.
- Database (real Postgres, migrations 01/02): reservations, commit, release, throttles, concurrency, rollback, Tailor allowance.
- Functions with a **mock** Anthropic server and mock database client: model/request shape, reply parsing, integrity guard, charging only for accepted results, no-change and flagged-only releases, size limits, usage-log privacy, publication rules and headers (as configuration), no secrets in public files.
- Export matrix: 12 templates x six very different fictional resumes x PDF and Word.
- Browser (Chromium via Playwright, **local** static server with the production headers and CSP applied): guided builder, Analyze/Polish/Tailor/Restore flows, one-AI-step-at-a-time lock, mobile sizes 375x667 and 320x568, licensed PDF download.

### B. Checks against the deployed Netlify branch
**None have been performed.** This environment cannot reach the branch deploy (proxy returns 403) and the Netlify connector needs owner sign-in. Everything below is still open and is on the owner checklist:
- that the 404 rules and security headers actually take effect on Netlify;
- that the page loads and downloads work on the real deploy, Safari/iOS and Firefox;
- that environment variables are present for the branch context;
- that `check-code-supply` is or is not reachable;
- that the live model works with the new code.
- Earlier, the owner ran real-browser tests on older commits (f7ef615, 9121379); those do not cover this commit.

## Minimal owner acceptance checklist
**Free first (no AI, no generation). Items 1 to 3 on the branch deploy; item 4 on production only after release if you prefer no side effect.**

| # | Check | Pass looks like |
|---|---|---|
| 1 | `SETUP.md` 5b: the 404 loop, the 200 loop, the header `curl` | every blocked path 404; five page URLs 200; all five headers present |
| 2 | Open the page with the console open: gate, guided builder, Try Sample; PDF button without a code | no "Refused to..." / Content-Security-Policy messages; the gate appears; nothing downloads |
| 3 | iPhone Safari and Android Chrome: tap a field, step through the builder, open the editor, scroll to the bottom | no zoom jump; export buttons do not hide the last field |
| 4 | `/.netlify/functions/check-code-supply` (see `docs/CODE_SUPPLY_EXPOSURE.md`) | 404/not reachable, or note the JSON for the follow-up fix |
| 5 | With your personal code: download a PDF and a Word file | files open; counter unchanged |

**Then at most ONE generation credit (personal license, fictional data; check the counter first):** one Polish run on the fictional Taylor Rivera resume that includes the blank project description and the "Helped organize" bullet, plus a few plain lines.
- Pass: honest improvements applied; the blank description is NOT filled in and "Helped organize" is NOT inflated; the card says where and why something was left out; the counter drops by exactly 1; the log has an `ai-usage` line.
- It covers the live model, the stricter guard and charging in one run. If the result is "nothing to improve", the counter must not move (log ref P201/P202) and no credit is spent.
- Optional in the same session at no credit: Tailor that result to a short fictional job description (Tailor does not consume a generation) and read `ms`/`out` from the log.

Skip for now unless item 1 of the risk list is not enough: Analyze with a no-email resume and the long 3 to 5 page resume (each costs a credit).

## Last documentation note
A documentation-only push still rebuilds the branch deploy; do not push while you are in the middle of testing.
