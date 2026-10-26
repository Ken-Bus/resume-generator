# Flex & Grace AI Resume Generator: Pre-Release QA, Consolidated Report (2026-10-23)

Branch `feature/guided-resume-and-export-fixes`, final commit `dd4733b` (pushed). Fictional data only. Nothing merged, deployed or published. No paid Anthropic call was made. Founder OS, Supabase production, Netlify production and Etsy were not touched.

## 1. Verdict: **NOT READY for release as-is. READY to proceed to the owner acceptance tasks in section 15.**

The code on this branch passes everything that can be proven locally (529 of 529 tests, 0 skipped). NOT READY is the honest verdict because the release gate requires evidence this campaign was forbidden to produce:

| Gate item | Status |
|---|---|
| Known unresolved critical/high defects | None open in the product code. Two residual risks are disclosed (R1, R2 in section 11). |
| Incorrect credit accounting | None found after fixes (real SQL, 33 DB tests, fault injection, collective-charge boundaries). |
| Preventable loss of customer work | Fixed (D-009, D-010, D-018). Residual: closing the tab on purpose clears the saved copy (by design, stated in the FAQ draft). |
| Reproducible unsupported claims | None reached an accepted resume in 39 simulated inflated answers, nor 0 of 56 in the independent dishonest holdout. This is a pattern-based guard: it is strong against the classes tested, not a proof. |
| Unauthorized paid API or export access | None found. Code-guess oracle closed (D-005). |
| Broken preview/export parity | None found on the sampled templates (section 8). |
| Core journey failure | None in the mocked-model journey. **The real model has never been run**, so real writing quality and real timing are unverified. |

Why not READY: (a) no live-model evidence, (b) no deployed-environment evidence (headers, real timing, devices), (c) the replay protection for a lost reply is in memory only, so a cold instance can double-charge a retried Analyze (R2). A conditional READY is reasonable once the five owner tasks in section 15 pass.

## 2. Inventory and coverage map

Functions: `parse-resume` (Analyze), `polish-resume`, `tailor-resume`, `verify-license`, `export-resume`, `consume-generation` (shim), `check-code-supply`, plus `_lib` (integrity guard, scoring, replay, in-flight, limiter, usage). Client: `index.html`, `wizard.js`, `resume-core.js`. Database: reservation functions (`reserve_license_use`, `commit_license_use`, `release_license_use`, `consume_tailor_use`).

| Area | Tests | Evidence type |
|---|---|---|
| core (pure logic) | 12 | local |
| db (real Postgres 16, real migrations) | 33 | real SQL |
| functions (real handlers, mocked Anthropic) | 340 | real SQL + mock model |
| ui (Playwright, Chromium, mocked endpoints) | 144 | local browser |
| **Total** | **529 pass, 0 fail, 0 skipped** | `npm run test:release` |

Requirement-to-evidence traceability is kept in the test files' names and `tests/README.md`; each Round 1 requirement (entitlement, charging, no-charge-on-failure, one-at-a-time, replay, privacy, export parity, work safety) maps to at least one named test and, where possible, a mutation that kills it.

## 3. Defect register (22 items, all with a disposition)

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| D-001 | HIGH | Analyze had no one-at-a-time guard: 5 simultaneous requests charged 5 generations | Fixed, tested |
| D-002 | MED | Analyze had no replay: lost reply plus retry charged twice | Fixed in memory; **durable fix needs a schema change (not allowed): residual R2** |
| D-003 | REQ | Approved collective charging rule not implemented | Implemented (`_lib/scoring.js`, 3-point threshold) |
| D-004 | LOW | DB error text (could echo a code) written to logs | Fixed |
| D-005 | LOW | Code-guess oracle on parse/polish/consume | Fixed (per-client limiter) |
| D-006 | MED | Guard rejected the owner's own approved example ("Helped train…") | Fixed |
| D-007 | HIGH | Stemmer bug: carry/carried, apply/applied, family/families withheld as "new details" | Fixed |
| D-008 | MED | 50% of honest single-line edits withheld | Fixed (see accuracy below) |
| D-009 | HIGH | Refresh/close/tab discard erased the whole resume, including a charged mid-polish result | Fixed (tab-scoped autosave, pending-request recovery) |
| D-010 | LOW | Second polish overwrote the customer's own wording as the restore point | Fixed ("Restore what I wrote before the first polish") |
| D-011 | LOW | `check-code-supply` returned inventory counts | Fixed (`{ok:true}` only) |
| D-012 | TEST | 8 UI suites silently skipped on a different Chromium path | Fixed (`tests/ui/browser.js`, `run-release.js` fails on any skip) |
| D-013 | HIGH | A line correcting two or more misspellings was withheld | Fixed |
| D-014 | HIGH | Skills with corrected spelling always withheld | Fixed |
| D-015 | HIGH | An unsupported skill (from the goal text) was accepted and charged | Fixed |
| D-016 | LOW | Abbreviation expansion withheld | Fixed |
| D-017 | LOW | Slow AI reported as "resume too long" | Fixed |
| D-018 | HIGH | Page died if sessionStorage threw | Fixed |
| D-019 | MED | Corrected spelling of the beneficiary withheld | Fixed |
| D-020/021 | MED | Further guard honesty/accuracy cases found in Round 3 | Fixed |
| D-022 | MED | Sparse resume told "already clear" (misleading) | Fixed: sparse reason, no AI call, no charge |
| D-023 | MED | Found in final regression: guard tidy merged lines that differ only by a number, and could credit a repeat the AI never removed | Fixed in `dd4733b` |

Known limits, not fixed (disclosed): Analyze copies text verbatim (spelling correction needs Polish); fact fields (titles, schools) are never spell-corrected; dates and contradictions are not flagged; an unbroken 5,000+ character token loses its tail in the PDF; a lead-verb typo such as "cary" is not salvaged when a line is withheld.

## 4. Test weaknesses and mutation survivors

As-found battery (42 mutations): 37 killed, 5 survived. Final battery (71 mutations on the near-final code): 66 killed, 5 survived. After adding tests, two survivors are now killed (N08, N12; each confirmed by re-introducing the mutation and watching the new test fail).

| Mutation | Result | Explanation |
|---|---|---|
| M16 name/contact restored a second time | Survives | Equivalent: `reconcile()` already restores them |
| M41 client single-flight lock removed | Survives | Equivalent: other guards (server one-at-a-time, disabled button) catch it |
| M24 double-click polish sends twice | Survives | **Weak assertion**: UI test does not assert "no error banner" on double-click. Open item, low risk |
| N08 Polish guess limit removed | **Now killed** | New test in `analyze-guard.test.js` |
| N12 spelling salvage off | **Now killed** | New test in `guard-accuracy.test.js` |

Disclosure: the final battery ran before the last three code edits (tidy scoping, number-aware dedupe, repeat-credit rule). Those edits are covered by the full 529-test run but were not individually mutation-tested.

Test weaknesses found and fixed: silent UI skips (D-012); a "5 simultaneous requests succeed" test that blessed the Analyze double charge; a one-word-touch-up charge (M03) caught only by the stress matrix; a timing-sensitive simultaneous-request test (150 ms AI delay) that flaked intermittently (about 1 run in 6), now 700 ms and stable across 10 repeats.

## 5. Fault injection and recovery

Real handlers against real Postgres with `pool.query` wrapped to inject failures.

| Fault | Result |
|---|---|
| Reservation call fails (serialization error) | 503, nothing charged, no code in logs |
| AI timeout / truncated / malformed JSON | Reservation released, nothing charged, accurate message (slow vs too long) |
| AI answer arrives after client gave up | Charged once; same `requestId` retry returns the same result, no second AI call |
| Commit fails after AI success | Customer not charged for an undelivered result; reservation expires |
| Two tabs / double-click | One AI call, one charge, loser gets a clear message and is free |
| Storage throws on the page | Page still works without autosave |
| Reload mid-polish | Resume restored; pending `requestId` reused, no double charge |
| **Cold instance retry** (replay cache lives in memory, 5 min) | **Can double-charge: residual R2** |

## 6. Complete before/after resumes

Full examples (fact sheet, before, simulated answer, accepted result, withheld lines with reasons, score) are in `docs/QA_ROUND3_OUTCOMES_2026-10-23.md`, regenerated from the final code. Summary of 13 fictional applicants times 3 simulated answers (careful, natural, inflated):

| Answer | Charged | Notes |
|---|---|---|
| careful (ideal editor) | 10 of 13 | the 3 free ones had fewer than 3 points of real improvement |
| natural (plausible LLM) | 10 of 13 | |
| inflated (invents numbers, leadership, praise) | **0 of 13** | inflation reaching the accepted resume: **0** |

**Label: every answer above is a SIMULATED model answer written by the QA author.** The real Sonnet 5.5 has not been run. Whether it writes in the customer's voice at the 3-point threshold is the single biggest unknown.

Independent holdout (written by a separate subagent, then evaluated): honest edits kept 94%; 0 of 56 dishonest edits leaked; natural-faithful edits kept 53%; 1 of 48 "reach" edits leaked (the "checking the pharmacist's work" class), fixed narrowly afterwards. **Independence limit:** after seeing the holdout results I tuned the guard, so the post-tuning numbers are no longer independent. The first-pass numbers are the honest estimate of generalization.

## 7. Collective-charge boundary tests

Approved rule: rewrite 3; spelling/grammar/tense 1; genuine repetition removed 1; vague wording made specific and supported 1; cosmetic, synonyms, unsupported 0; 3 or more applies and charges exactly one; under 3 keeps the original and charges zero. Tested in `scoring.test.js` (pure) and `collective-charge.test.js` (real SQL, 14 tests): 0, 1, 2, 3, 4 and 5 points; the same correction on five lines counted once; a rewrite plus corrections not double counted; rejected material earns nothing; retries and races charge once; the $11 price, five generations and Tailor allowance unchanged.

## 8. Security, privacy and cost evidence

- Secrets: none in the repository or logs (pattern scan of the branch diff for API-key, JWT, private-key and password literals found none; tests use mock values).
- Logs: DB errors never include the code (tested); resume text is not logged.
- Code-guess protection: 30 failed attempts per client per 10 minutes on verify, export, parse, polish, consume; real customers on other connections unaffected (tested for Analyze, Polish, consume, verify).
- Cost: one paid operation at a time per code; sparse resumes never call the AI; oversize requests are refused before any AI call; failed AI calls are free.
- Export: gated by a valid code; parity checked on sampled templates; text in the PDF is real, selectable text. Not tested against any applicant-tracking system.
- **Not verified:** response headers on the deployed site, CSP, real Netlify timeouts.

## 9. Exact suite counts and skip explanation

`cd tests && node run-release.js` gives: **529 passed, 0 failed, 0 skipped, 0 cancelled, of 529** (core 12, db 33, functions 340, ui 144). The baseline of 463 grew by 66 (new scoring, collective-charge, Analyze, guard-accuracy, code-supply and work-safety tests). Earlier, "skipped 8" in the baseline was the UI suites being silently skipped (D-012). The release runner now fails on any skip, and `REQUIRE_BROWSER=1` fails when no Chromium is found.

## 10. Evidence labels

| Label | What it covers |
|---|---|
| Local mock | Anthropic responses, endpoint mocks in the browser tests |
| Real SQL | Postgres 16 with the real migrations; real handlers |
| Local Chromium | Layout, preview, autosave, beforeunload (desktop and phone-sized viewports) |
| **Not run: Netlify deploy** | Headers, cold starts, real timeouts, long-resume timing |
| **Not run: live Anthropic** | Real writing quality, real latency, real refusal behavior |
| **Not run: Android / iOS devices** | Real tab discard, keyboards, file download |

## 11. Ranked remaining risks

1. **R1: Real-model quality unknown.** The strict guard may withhold much of what the real model writes (natural-faithful kept 53%), so customers may often get a "nothing to apply" result. Mitigation: owner task 2.
2. **R2: Lost-reply replay is in memory only.** A retry that reaches a cold instance is a normal request and charges again. A durable fix needs a schema change, forbidden here.
3. **R3: Deployed behavior unverified** (headers, timing for the longest resume, cold start).
4. **R4: Guard is pattern-based.** Strong on tested classes; an unseen phrasing could slip a reach through. Customers are told to read their resume.
5. **R5: Phone behavior unverified** on real devices.
6. **R6: Strict charging may feel stingy** (a useful one or two word fix is free and not applied). Disclosed in the FAQ draft; this is a business tradeoff for Opus-level review.
7. **R7: M24 weak UI assertion.**

## 12. Copy / FAQ / marketing audit (Etsy NOT edited)

- Rewritten FAQ draft: `docs/ETSY_FAQ_AI_POLISH.md` (status: draft, not published). Publish only after merge and deploy, because the live app differs until then.
- Flags: the free sample is a fictional senior retail executive and could look like what the AI writes for a first-time job seeker (do not present it as an AI result); the delivery text omits the Guided Builder; do not claim "ATS-friendly", "ATS-optimized", "gets interviews", "never makes mistakes", or name the underlying model.
- The FAQ states the 3-point rule, restore options, the in-tab saved copy and its privacy, the lost-reply behavior "within a few minutes", and the length limits.

## 13. Post-release monitoring and regression process

Watch daily for the first two weeks: the `ai-outcome` log lines (`charged`, `no-change`, `flagged`, `minor`, `sparse`, `unchanged`) and their ratio; points distribution; Anthropic spend per paid code; 429 and 5xx rates; customer messages mentioning "missing generation". Alert if the free-polish ratio exceeds 60% or `flagged` exceeds 40% (the guard is too strict) or spend per code exceeds the plan. Before any change to the guard, scoring or reservation SQL: run `npm run test:release`, then the mutation script on the touched file, and re-check the Round 3 outcomes doc.

## 14. Skill recommendations (recommendation only, nothing created)

- A product-agnostic "pre-release QA campaign" skill: discovery-first, mutation testing, fault injection, requirement-to-evidence matrix, mock-versus-real labeling, an explicit release gate and a no-skip test runner.
- A "paid-AI feature trust check" skill: charge-on-success only, one-at-a-time, replay safety, code-guess limits, log privacy.
- For Founder OS (owner to decide, not applied): a standing rule that test runs must fail on skip, and a rule that AI-judged charging is never used (deterministic scoring only). Per your preference, strategy calls like the 3-point threshold belong in an Opus session.

## 15. Owner-only acceptance tasks (minimal)

1. Merge and publish through your normal process, then open `/.netlify/functions/polish-resume` and confirm it shows `entry-scope-withhold-6`.
2. **One paid generation** on a personal test code with a real fictional resume, to see real model quality and the real charge or no-charge outcome (this needs your explicit authorization; I did not do it).
3. Phone pass on one Android and one iPhone: build a resume, refresh mid-way, polish, download PDF and Word.
4. Compare the PDF and Word output to the preview for two templates.
5. Paste a 5 to 6 page fictional resume and time Analyze and Polish on the deployed site.
6. Review the FAQ draft before it goes on Etsy.

## 16. Files changed, commits, and restrictions observed

Commits on the feature branch (last pushed `dd4733b`): scoring, replay and in-flight modules, integrity guard rework, polish/parse/tailor/consume/code-supply endpoint changes, client work-safety (autosave, restore, pending recovery), new and updated tests (`scoring`, `collective-charge`, `analyze-guard`, `guard-accuracy`, `code-supply`, `work-safety`, `run-release`, `browser`), and docs (`SETUP.md`, `ETSY_FAQ_AI_POLISH.md`, `PROPOSAL_COLLECTIVE_CHARGING.md`, this report, `QA_ROUND3_OUTCOMES_2026-10-23.md`).

Restrictions observed: no merge, no PR, no deployment, no production Supabase or Netlify change, no Etsy change, no paid Anthropic call, no real customer data or keys, fictional data only, the 5-generation entitlement, Tailor allowance and $11 price unchanged, Founder OS not edited, committed or pushed. **Disclosure:** an earlier step in this session ran a read-only directory listing and `git status` in `/home/user/founder-os`; nothing was read from its content files or changed. One subagent wrote the holdout corpus (independence limits in section 6). The session is still open: no session recap and no Founder OS update has been made, and none will be until you close it.
