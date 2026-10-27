# Release readiness: included AI Polish, four-day access, Everyday Jobs

Branch (local only): `feature/stage2-application` @ latest commit. Includes Migration 05 and the Everyday Jobs templates. Not pushed, merged or deployed. Not applied to production.

## Final gate (one run, local PostgreSQL 16, AI mocked, no production system)
745 tests across the browser, core, function and database suites: **743 pass, 2 fail**. Both failures are one test, `backup-restore` (cleanup `dropdb --force` of a disposable database while many suites ran at once). Run alone it passes 6 of 6. Cause: parallel load on the disposable database, not the application.

## Failures seen on the way, by cause
| Cause | Examples | Verdict |
|---|---|---|
| Outdated test (policy changed) | Polish after an Analyze is now free; a code with no benefits is no longer downloadable; sign-in reports extra fields; save text "Progress saved"; the sample is now an everyday resume; guard version literal | Updated, no product defect |
| Test setup | Older suites built a database without Migration 05 (the new Polish refuses that by design); `pg` missing in a new working copy; my own mock and environment mistakes | Fixed |
| Disposable database | Connection limit too low for parallel suites; database stopped when the sandbox restarted; one cleanup race under load | Configuration only |
| Genuine defect | The pre-existing zero-generation sign-in lockout (customers at 0 could not sign back in on a refresh or a new device) | Fixed by this work and covered by tests |

## Confirmed by tests
- **Charging policy:** Analyze = 1; each paid Analyze earns one non-expiring included Polish; the first meaningful Polish uses it (no generation, works at zero); later meaningful Polishes = 1 each; failed, unchanged and insignificant results touch nothing; Guided Builder: every meaningful Polish = 1. A page that expects "included" when none exists is refused uncharged.
- **Protections kept:** integrity guard and 3-point scoring untouched; request-key replay returns the same result with no AI call and no second credit; simultaneous requests use the credit once; encrypted 24-hour recovery works for included results; Tailor allowance stays 5 per Analyze (the included Polish signs its parent Analyze).
- **Four-day access:** valid while generations or an unused included Polish remain; 96 hours of sign-in, editing, templates, preview and downloads after the last benefit; no AI inside the period; refused after it (sign-in and download); a top-up restores access.
- **Autosave:** saves after typing stops, every 10 seconds, and when the page is hidden; a killed tab is recovered with fields and template; "Progress saved on this device." only after a successful write; storage failures are stated plainly.
- **Downloads:** PDF and Word, real text, all 12 templates, for both the executive and everyday samples.
- **Everyday Jobs:** best-for notes, everyday tab names, everyday default sample, first-resume sections, single-column text in all templates.
- **Compatibility:** the previous application passes unchanged on databases with and without 05; this build against a database without 05 keeps sign-in and downloads as before and refuses every Polish before the AI call, charging nothing, so deploy it after the migration.

## Genuine release blockers
None in the code. Remaining items are owner actions and the paid live test (below).

## Exact production steps (each needs the owner's approval; nothing has been done)
1. Approve and push the branch; merge to main when you choose (Netlify stays locked).
2. Take a fresh encrypted backup and verify the restore (`docs/PRODUCTION_BACKUP_RUNBOOK.md`).
3. Supabase SQL editor, Resume project: run `docs/MIGRATION_05_PREFLIGHT.sql`. Expect "E: migrations 03 and 04 applied, 05 not applied", no live reservations, no name collisions. Keep the balance fingerprint.
4. Run `supabase/migrations/20261027_05_included_polish.sql` once.
5. Run `docs/MIGRATION_05_POSTCHECK.sql`. Expect verdict PASS and the same fingerprint. If the API reports PGRST202, run `notify pgrst, 'reload schema';`.
6. Create the isolated test code: `insert into licenses (code, max_uses, uses_remaining, assigned) values ('FG-QA05-TEST', 5, 5, true);`
7. Deploy to the unpublished production deploy. Open `/.netlify/functions/polish-resume` in a browser: it must show guard version `included-polish-1`.
8. Live test on the test code with fictional data (about 2 generations): Analyze (4 left) -> refresh and a private window ("included" still shown) -> Polish (included, still 4) -> second Polish (3) -> restore own wording (still 3) -> download PDF and Word. Then set only the test code to zero (`update licenses set uses_remaining = 0 where code = 'FG-QA05-TEST';`) and confirm sign-in and download work and the four-day notice shows.
9. Delete the test code: `delete from licenses where code = 'FG-QA05-TEST';`
10. Publish the deploy, update the Etsy listing and FAQ (draft is `docs/ETSY_FAQ_AI_POLISH.md`), and watch the Netlify function logs for 24 hours (503s, "reserve_license_use is missing", `ai-usage` cost lines).

Rollback: redeploy the previous Netlify deploy first, then, only if needed, `supabase/rollback/20261027_05_rollback.sql` (reverse order: 05, then 04, then 03). Nothing a customer paid for changes.

## Known, not blocking
Customers who reached zero more than 96 hours before launch stay refused (they are already locked out today). The Etsy Apps Script could not be inspected (matters only for codes with no recorded step). Real AI cost per Polish is an estimate until the logs show it.
