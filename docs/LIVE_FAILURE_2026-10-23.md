# Live AI Polish failure, 2026-10-23: root cause and verification

**Reported:** after AI Polish on the feature deployment (fictional Taylor Rivera, School Food Drive project with a BLANK description) the page showed `Helped collect donated food for families in the community.` as the description and `... donate canned food for families in the community.` as bullet 1. "For families in the community" was never supplied.

## Finding
**The reported screen is exactly what the server returned at commits 884640f and 9121379, and it is impossible with the current code (d4d480c and be8f9b4 before it).**

| Evidence (deterministic replay of the exact live AI answer) | Result |
|---|---|
| Server at 884640f (`reconcile` flags the two lines but **keeps** them, reply has `unverified` set) | description `Helped collect donated food for families in the community.`, bullet 1 `... for families in the community.`, bullet 3 `Helped organize donated food for pickup.` : **identical to the live screen** (the two lines would also be yellow "Added by AI") |
| Current server (`guardResume`: flagged lines are **withheld** and put back to the customer's wording) | description blank, bullet 1 the customer's own, bullet 3 accepted : the invented claim cannot be returned |
| 14 data-shape variants (description missing/null/spaces, other entries that do mention families, extra or empty rows, project also listed as a job, AI renaming or shifting the entry, AI putting text in the wrong field) | none survives |
| Browser: real page + real guard + exact live answer, desktop and 360 px Android | nothing reaches the preview, the editor or the page data; no yellow lines |

Checked and cleared: the AI response handling (`assertResumeShape`, reply parsing), entry-scoped validation (blank description is always flagged), accepted-result reconstruction (`Core.clean` after `withholdFlagged`), the frontend (applies the server's `result` exactly; no merge with older text), stale in-page data (the page sends its current data; blank rows are cleaned server side), and caching (replays return the stored guarded body).

## Conclusion, and what is NOT proven
Most likely the branch deploy that served the test was **running an older build** (884640f or earlier), not the current one. Every layer of the current code was exercised and none can produce the result. I cannot prove which build served the test: this environment cannot reach Netlify, no function log or response body was supplied. Notably, `netlify.toml` first changed in be8f9b4 (publication rules and headers); if Netlify rejected that file the branch would keep serving the previous successful deploy. The file parses as valid TOML here; Netlify's own build log is the place to confirm.

## What changed (small, no new features)
1. **A build stamp, so this can be checked for free.** `ResumeCore.GUARD_VERSION` (`entry-scope-withhold-3`) lives in `resume-core.js`, which the page and the AI functions both load. Polish replies carry `guard: { version, withholds, deploy }` (also on the no-code reply), and every `ai-outcome` log line carries `guard`.
2. **Regression coverage that fails on the live result:** `tests/functions/live-replay.test.js` (guard, 9 data shapes, Tailor, real-SQL handler incl. charge-once and stamp) and `tests/ui/live-replay.test.js` (browser, desktop and Android width). The old "flag but keep" behaviour is pinned as the thing the pipeline must never use.
3. No change to the integrity rules, charging, licensing, Tailor, export or security headers.

## Free check before any further paid test (no credit, about a minute)
1. Netlify > Deploys > the branch: confirm the **published** deploy is commit `d4d480c` or later, with status "Published" (not failed). If a newer build failed, open its log and send me the error.
2. On the branch site, browser console: `ResumeCore.GUARD_VERSION` must print `entry-scope-withhold-3`. (`undefined` = old page.)
3. `fetch('/.netlify/functions/polish-resume',{method:'POST',body:'{}'}).then(r=>r.json()).then(console.log)` must print `guard: {version: 'entry-scope-withhold-3', ...}`. (No `guard` = old functions.)
4. Only then repeat the Taylor Polish (one credit). With the current build the description stays blank, bullet 1 stays as written, and the card lists "left out" items. The Netlify log line `ai-outcome` shows `"guard":"entry-scope-withhold-3"`.
