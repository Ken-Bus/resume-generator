# AI Polish ("Polish My Resume with AI"): as built

**Status:** implemented on the feature branch; **not merged or deployed**. Costs **one of the five included generations per successful polish**. No price or entitlement change.

**Where it appears:** the last step (Review) of the guided builder, **and at the top of the regular editor (Edit Fields)** for any licensed resume with something to polish, so it is easy to find after leaving the builder. Both places share one state: a polish started or finished in one shows in the other. Nothing is charged by navigating, typing, previewing, switching templates or editing.

**Customer flow**
1. The button states the cost: "Uses 1 of your N remaining generations."
2. A first click only opens a confirmation ("This will use 1 of your N generations remaining. You are only charged if the polish completes"). Cancel does nothing.
3. A second, deliberate click ("Yes, polish my resume (uses 1)") sends the request. While it runs, the button and step navigation are locked.
4. The result replaces the wording in the editor. The page shows what was reworded (with **Restore my wording** per section and **Restore all my original wording**), and any line the AI added that the customer didn't provide is highlighted yellow in Edit Fields with "Added by AI: please make sure this is true".
5. The customer can then Tailor to a job (free, 5 runs) and download.

**Charging (`netlify/functions/polish-resume.js`, same model as Analyze)**
- All validation (code format, size, "is there anything to polish") runs **before** any reservation or AI call.
- `reserve_license_use` -> AI -> validate -> `commit_license_use`. Any failure -> `release_license_use`; provider outages never count toward the failure budget; the per-code throttle (6 costly failures per 15 minutes, 30 per day) applies unchanged.
- Issues the same signed `tailorToken`; Tailor remains token-gated, free, capped at 5 runs per paid generation.
- **Duplicates:** (a) the button is single-flight; (b) only one paid operation runs at a time per code (an Analyze or polish already in flight makes a second request return 409, uncharged); (c) a retry that reuses the `requestId` of a finished polish returns the same result without a second charge (best-effort: kept in memory on the serving instance for 5 minutes). A persistent idempotency key would need a database column; it was not added (no migration).
- No SQL migration. No new environment variable.

**Writing quality (`polish-resume.js` prompt)**
- **Audience.** The customer says which fits them on step 1 (first resume / I've worked before / changing to different work); otherwise it follows from the answers (no jobs = first resume). The prompt sends only the matching guidance: *first resume* draws on school, volunteering, projects and training without making them sound like paid work; *experienced* makes duties specific and scannable, keeps long tenure and dates, and never turns routine duties into achievements; *career changer* words real duties so what carries over is clear, and never claims experience in the new field. Unknown values are ignored, and a choice that makes no sense (e.g. "experienced" with no jobs) falls back to the answers.
- **Style.** Natural, modest, professional language; real improvement (say what was done, with what, using the customer's own words and meaning) rather than added adjectives; a named list of generic AI phrases to avoid unless the customer wrote them; concrete good/bad examples in the prompt. The goal text is length-limited and stripped of quotes so it cannot alter the instructions.

**Truthful content (`_lib/integrity.js`)**
- The AI only receives the customer's own answers, with a prompt that forbids new facts, numbers, credentials, leadership or entries.
- Facts (name, contact, employers, titles, dates, schools, degrees, certifications, awards, locations) are **restored deterministically** from the answers after the AI returns; invented jobs/projects/volunteer entries are dropped; a dropped entry is put back.
- Lines with numbers, leadership wording or credential wording not in the answers, new skills, and **any AI-written headline or summary** are flagged for the customer to confirm. Flags are heuristic: they warn, they never delete. An empty work history stays empty and is never an error.

**Known limits**
- The flags are keyword/number based. A made-up claim in plain words that avoids every listed word and uses fewer than two unfamiliar words can still pass, and an honest rewording that uses two unfamiliar words will be flagged; the customer always has Restore.
- If the reply is lost after the charge, the customer is told to check the counter; retrying with the same request id on the same warm instance will not charge again, but a different instance cannot know about the first.
