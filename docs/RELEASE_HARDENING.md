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

## Remaining risks (honest list)
1. **Nothing has run against the real Sonnet 5.5 yet** beyond the customer's earlier real-browser tests. The request shape, reply parsing, prompts and the new guard have been tested against a mock that rejects what the real API rejects, not against the live model. The new Tailor/Analyze behavior and the stricter Polish guard are untested live.
2. **Long-resume timing is unknown.** The size limits are arithmetic (about 0.385 output tokens per JSON character), not measured. The `ai-usage` line gives tokens and milliseconds per call: calibrate after the first long run.
3. **Pattern-based checks.** A fabricated claim in plain words that avoids every pattern can still pass; an honest line that uses a pattern word not in its entry is withheld.
4. **In-memory limiters** (`verify-license`, export, free-attempt cap) are per serverless instance. Durable cross-instance limits need a database change (not approved).
5. **Headers and 404 rules are configuration** that only takes effect on a Netlify deploy. Tested for correctness of the rules and for the page working under the policy in Chromium; not tested on Safari/Firefox/iOS.
6. **`check-code-supply`** is a scheduled function but may also be reachable as a URL, where it reports and tops up the unassigned-code count without authentication. Not changed (it is production-critical). Owner check below.
7. **`consume-generation`** is a deprecated read-only shim; remove it once no old tabs can exist.

## Owner acceptance checklist
**Free (no generation, no AI), on the branch deploy:**
1. Publication and header commands in `SETUP.md` section 5b: all blocked paths 404, page files 200, five headers present, no Content-Security-Policy messages in the browser console while using the gate, builder and sample.
2. `https://<site>/.netlify/functions/check-code-supply`: note what an anonymous visitor sees.
3. On a real phone (iPhone Safari and Android Chrome): tap into a field (no zoom jump), step through the builder, open the editor, scroll to the bottom (export buttons do not hide the last field).

**Paid (separate approval; personal license, fictional data; the counter shows how many are left):**
4. Analyze one fictional pasted resume that contains **no email**: the editor must not invent one.
5. Polish the Taylor Rivera project with the blank description and the "Helped organize" bullet: the three problems must be left out; the card names where and why; the counter does not move if nothing else was improved.
6. Polish a resume with a few plain lines: at least one honest improvement is applied, one generation is used.
7. Tailor the result to a short fictional job description: it works, the counter does not move, any "left out" list is shown.
8. One long fictional resume (3 to 5 pages): note `ms` and `out` in the `ai-usage` line, and whether it finishes without the "too long" message.
