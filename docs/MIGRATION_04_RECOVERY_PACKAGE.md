# Migration 04: temporary encrypted result recovery — review package and runbook

Status: **built and tested locally only.** Nothing has been applied to production, no secret has been created, nothing is deployed or merged. Fictional data only; no paid AI calls were made.

## 1. What it does

- **Local drafts (client only).** The page saves the unfinished resume in the customer's own browser (`localStorage` key `fg_draft_v2`) shortly after typing pauses, and again when the page is hidden or closed. Nothing is uploaded. Access codes, API keys and Tailor tokens are never written to the draft. Drafts expire after 14 days. A newer draft is never overwritten by an older snapshot (revision + tab id rule). Blocked or full storage shows an honest "not saved on this device" status, never a false "saved". Offers: Continue where I left off / Start fresh / Clear this saved copy.
- **Temporary encrypted recovery (server).** When an AI **Analyze** or **AI Polish** generation is accepted and charged, the result is encrypted (AES-256-GCM, per-record key from HKDF-SHA256, record id and step bound as authenticated data, gzip before encrypting) and stored in `result_recovery` **in the same database transaction as the charge** (`commit_license_use_with_result`). Tailor is excluded. The customer retrieves it with only the original access code ("Restore my result"); no extra generation, no extra Tailor allowance, no regeneration when the stored copy exists.
- **Fails closed.** If `RESULT_ENCRYPTION_KEY` is missing/short, or migration 04 is absent, Analyze and Polish return 503 **before** any AI call and nothing is charged.
- **Retention.** Every row has `expires_at <= created_at + 24 h` (table CHECK). Expiry is enforced inside the read functions on every call, so an expired row is never returned even if cleanup is late. `purge-recovery` (hourly scheduled function), `check-code-supply` and the list call delete expired rows. Rows are not deleted just because a response was sent.
- **Not stored:** raw prompts, the pasted source resume, the access code, keys, decrypted results in logs.

## 2. Files (SHA-256)

| File | SHA-256 |
|---|---|
| `supabase/migrations/20261024_04_result_recovery.sql` | `0fa8d9a66b290a68d204c564846dfb5b5b4597eeba4baf24687745eb66c323cf` |
| `supabase/rollback/20261024_04_rollback.sql` | `cdb2efcf10d2b8371ceb5337a595731f759a4a9eb68e90a479147cd6bc578eae` |
| `netlify/functions/_lib/vault.js` | `c5a060253cef2c7c957554d7835761795e31f0e6c8cabab6b81d11c40972d4bd` |
| `netlify/functions/recover-result.js` | `c743d91921ce38dc8ec690d8fc12eec9bd6bf0240b38022e1ebc7d94b6736919` |
| `netlify/functions/purge-recovery.js` | `27340c1e977cdc6c23e79138fc25760723b5fd500f7e2095aea1267295be1bd2` |

Also changed: `parse-resume.js`, `polish-resume.js`, `_lib/license.js`, `_lib/recovery.js`, `check-code-supply.js`, `netlify.toml` (hourly schedule), `index.html`, `wizard.js`, `supabase/schema.sql`.

## 3. Security model

- Authorization: the access code only; every query is scoped to that license. Unknown code, unknown id, expired, other customer's record and decrypt failure all return the **same generic 404**.
- Guessing: per-client failure limiter (30 per 10 min) plus a per-client lookup limiter (30 per minute); input is validated before the database is touched. Limiters are in-memory per function instance (same pattern as the other endpoints), so the limit is per instance, not global.
- Database: RLS on, no grants to `anon`/`authenticated`; functions are `SECURITY DEFINER` with fixed `search_path` and executable by `service_role` only.
- Keys: dedicated `RESULT_ENCRYPTION_KEY` (>= 32 chars), separate from `TAILOR_TOKEN_SECRET`. Optional `RESULT_ENCRYPTION_KEY_PREVIOUS` allows rotation: records carry a key id and open with whichever secret matches. Server-side only.
- Logging: no resume content, codes, keys or decrypted results; support reference only.

## 4. Deployment runbook (OWNER ONLY — nothing here was done)

Order matters; an app deployed before steps 1–2 refuses Analyze/Polish (503, no charge), which is safe but customer-visible.

1. Review this package and the migration SQL.
2. Owner creates a random secret of at least 32 characters and sets `RESULT_ENCRYPTION_KEY` in Netlify (all contexts that serve production). Store it in a password manager; losing it makes stored results unreadable (they expire in 24 h anyway).
3. Owner applies `20261024_04_result_recovery.sql` to Supabase (after migration 03). Reload the PostgREST schema cache if prompted.
4. Merge and deploy the feature branch; confirm the hourly `purge-recovery` function shows in Netlify.
5. One paid smoke test with the owner's own code: Analyze, close the tab, reopen, "Restore my result" (no generation used). Then confirm the counter.
6. Abort/rollback: `supabase/rollback/20261024_04_rollback.sql` drops the functions and table (at most 24 h of copies lost, no balance changes). After rollback the new app refuses paid steps; redeploy the previous app first if that is not acceptable. Compatibility matrix is in `tests/functions/compat-matrix.test.js`.

Backups: encrypted copies may persist in Supabase backups beyond 24 h. We promise application-level availability of 24 h, not physical deletion at exactly 24 h. Customer wording says so (`docs/ETSY_FAQ_AI_POLISH.md`).

## 5. Privacy wording (draft for owner approval; not published anywhere)

> **What we keep.** While you work, your draft is saved only in your own browser on your own device. It is not uploaded, it is deleted after 14 days, and it does not follow you to another device. After an AI Analyze or AI Polish generation is used, we keep one encrypted copy of that result on our server for up to 24 hours so you can get it back with your access code. It is encrypted before it is stored. After 24 hours it can no longer be retrieved and is deleted; an encrypted copy may remain in a system backup for a short time and cannot be read or restored there. We do not keep your pasted resume or the instructions sent to the AI for this purpose, and we do not write your resume or access code to our logs. Your resume text is processed by our AI provider to produce the result.

The Etsy FAQ draft has been updated to match. **No Etsy listing was changed.**

## 6. Test evidence

| Area | Suite | Result |
|---|---|---|
| SQL (real PostgreSQL 16): atomic charge+copy, scope, expiry, 24 h CHECK, purge, rollback | `tests/db/result-recovery.test.js` | 8 pass |
| Handlers: seal/commit, exact-copy replay, fail-closed, unauthorized/guessing/rate limits, no-leak logging | `tests/functions/result-recovery.test.js` | 24 pass |
| Local drafts in Chromium (desktop + Android viewport) | `tests/ui/drafts.test.js` | 12 pass |
| Restore my result in Chromium | `tests/ui/restore-result.test.js` | 8 pass |
| Interruption journeys in Chromium (Guided Builder power cut, restore then export and original wording, shared computer) | `tests/ui/interruptions.test.js` | 3 pass |
| Verification matrix and cost update | `docs/RECOVERY_VERIFICATION_AND_COST.md` | n/a |
| Full release run | `tests/run-release.js` | 651 pass, 0 fail, 0 skip |

Verified locally: all of the above. Simulated: Anthropic (mocked), Supabase client (mock over real SQL). **Not verified:** Netlify scheduled-function execution, real Supabase/PostgREST behavior and permissions, production key configuration, backup behavior, cross-device behavior on real phones, power-loss durability of `localStorage`.

Known note: one run of "B2 parse: concurrent failing bursts" failed once (6 vs 5 AI calls) while another suite was running concurrently; it passed on every isolated rerun and in the final full run. It exercises timing-sensitive per-instance limiters; do not run suites concurrently.

Mutation checks on the new logic (run on a scratch copy; 9 mutants): killed — read ignores expiry, fetch not scoped to the code, 48 h ceiling, purge keeps expired rows, vault without authenticated data, short key accepted, lookup rate limit removed, local draft never expires. One survivor, "list shows expired rows", is an equivalent mutant: the list function deletes the caller's expired rows first, so the extra filter is redundant (the fetch path, which returns content, is covered and killed).
