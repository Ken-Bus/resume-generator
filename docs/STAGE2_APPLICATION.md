# Stage 2: application changes for the included AI Polish and four-day access

Branch (local only): `feature/stage2-application`, built on `feature/included-polish-migration-05` (`3c7d4f1`) with `feature/everyday-jobs-templates` (`f7f798d`) merged in. Nothing is pushed, merged or deployed. **The database contract of Migration 05 is unchanged.**

## What the application does now
| Area | Behaviour |
|---|---|
| Analyze | Unchanged server-side (1 generation; the commit records its kind, which earns one included Polish). The page states the cost and what Analyze keeps before the click. |
| AI Polish | Always asks the database to consider an included Polish. If one exists it is used (even at 0 generations); a meaningful result then takes no generation. The page sends `expectIncluded`: if it showed "included" and none exists, the server answers 409 before the AI runs, charges nothing, and the card switches to the paid wording. |
| Not meaningful / failed | Released exactly as before; the included Polish and the balance are untouched. |
| Repeats / simultaneous | Existing request-key replay returns the stored result (no AI call, no second credit); the one-at-a-time rule and the database claim allow one winner. |
| Tailor | An included Polish signs its **parent Analyze**, so Tailor allowance is unchanged (5 runs per Analyze). Restoring an included Polish does the same. |
| Sign-in (`verify-license`) | A code with no generations left is valid while it has an unused included Polish or is inside its 96-hour completion period; it reports `includedAvailable`, `accessState`, `accessUntil`. Ended codes are refused with a clear message. |
| Downloads (`export-resume`) | Refused (403) once a code has no generations, no included Polish and its 96 hours are over. |
| Page | Charge wording before every AI action; restore note ("restoring does not give back..."); after Polish "Your resume has been updated. Download a copy..."; four-day notice only while it applies (adapted when an included Polish remains); download reminder beside the download buttons; "Progress saved on this device." only after a successful write. |
| Guard version | `entry-scope-withhold-6` -> `included-polish-1`: a page from before the release is told to refresh and is not charged. |

## Rollout order (unchanged from the Migration 05 package)
1. Fresh backup (owner). 2. Pre-check, migration 05, post-check (owner). 3. Deploy this build. 4. Paid live test on a fresh isolated test license.
Compatibility during the sequence: the published build `0a1a014` and the earlier candidate keep working against a database with 05 (SQL-level tests). This build against a database **without** 05 keeps sign-in and downloads as they were and refuses paid steps with a safe "try again" (nothing charged), so it must not be deployed before the migration.

## Live test plan (needs the owner; uses about 2 generations of a fresh test code)
Analyze (-1) -> refresh and open a private window: "included" still shown -> Polish (included, balance unchanged) -> a second Polish (-1) -> restore own wording (balance unchanged) -> download PDF and Word. Optional free check: set only the test code to 0 and confirm sign-in and download work, then use up its last benefit and confirm the four-day notice.

## Not done / awaiting approval
Applying migration 05, deploying, publishing, any production or license change, creating the test license, pushing or a pull request.
