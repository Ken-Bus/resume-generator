# Setup and Operations

How the 5-generations-per-code system is set up, how codes reach buyers, and how to release changes to it safely.

## How a generation is charged (read this first)

All billable work happens server-side. The browser never decides whether a generation is allowed.

1. **`parse-resume`** receives the license code and the resume text.
2. It **reserves** one generation in Supabase (`reserve_license_use`). This is atomic, so simultaneous requests can never hold more reservations than uses remain. A code with no uses left, or with all its remaining uses already in flight, is rejected **before any AI call**.
3. It runs the AI. If the AI errors, times out, is cut off, or returns something that isn't a usable resume, the reservation is **released** and the customer is **not charged**.
4. Only after a validated result does it **commit** the reservation (`commit_license_use`), which decrements `licenses.uses_remaining` exactly once. Commit is idempotent.
5. If the function crashes or is killed mid-call, nobody releases the reservation, but it has a short **lease** (45 s by default) and simply lapses. A failure can never permanently cost a use.
6. A successful parse returns a **signed tailoring token** (HMAC, 2-hour life) tied to that paid generation. **`tailor-resume`** requires it, costs no extra generation, and allows at most 5 runs per paid generation (counted atomically in the database).
7. "Try Sample" loads a static sample in the browser. It makes no AI call.

`consume-generation` is a **deprecated shim** that reads counts and never writes. It exists only so a browser tab opened before the release is not charged for a call the new server then rejects. Delete it about 72 hours after the release.

## 1. Supabase project

1. Create a free-tier project at supabase.com.
2. For a **new** project: run `supabase/schema.sql` in the SQL editor. It is idempotent and creates the `licenses` table, the reservation table and functions, and applies the lock-down below.
3. For the **existing production** project: do **not** re-run all of `schema.sql`. Apply only the migrations you have approved, in order:
   - `supabase/migrations/20261020_01_license_reservations.sql` — additive (new table and functions). Safe before the code deploy.
   - `supabase/migrations/20261020_02_revoke_public_execute_consume_license_use.sql` — one statement that stops the public `anon`/`authenticated` roles from calling `consume_license_use`.
4. In Project Settings → API, copy the **Project URL** and the **service_role** key (not the `anon` key). Nothing in this app uses the `anon` key.
5. **A merged change to `schema.sql` is not live until it is applied in Supabase.** After applying anything, re-run a read-only check that the live database matches (see "Verify" below).

The lock-down: `licenses` and `license_reservations` have RLS enabled with **no policies**, and every function is executable only by `service_role` (the key held by Netlify and by the delivery script).

## 2. Netlify environment variables

Set in Site settings → Environment variables, and **in all four deploy contexts** (Production, Deploy Previews, Branch deploys, Local development), or some code paths will keep running on a stale or missing value. Redeploy after changing any of them.

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | yes | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only key. Never put it in the browser, the repo, or a chat |
| `ANTHROPIC_API_KEY` | yes | AI provider key. Set a monthly spend limit on it |
| `TAILOR_TOKEN_SECRET` | yes, for tailoring | Random secret, **at least 32 characters** (for example from a password manager). If missing or short, resume analysis still works but tailoring is disabled and a warning is logged |
| `AI_TIMEOUT_MS` | optional (default 24000) | Abort an AI call after this long. Keep it below your Netlify function timeout |
| `CODE_SUPPLY_THRESHOLD` | optional (default 20) | Replenish when fewer unassigned codes remain |
| `CODE_SUPPLY_BATCH_SIZE` | optional (default 100) | Codes generated per replenishment |
| `ALERT_WEBHOOK_URL` | optional | Any HTTP webhook receiver for the zero-supply alert. Unset = the alert is only written to the function log |

## 3. Seeding license codes

```
npm install
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=xxxx npm run generate-codes -- 100
```

Inserts unique `FG-XXXX-XXXX` codes (5 uses each, unassigned) and writes a `licenses-<timestamp>.csv` in the current directory. Never commit that CSV (`.gitignore` excludes `*.csv`). Daily replenishment (`check-code-supply`) normally makes this unnecessary.

## 4. Delivery to buyers

Codes are delivered by a **Google Apps Script that lives outside this repo**, in the Gmail account that receives the shop's sale notifications. On a time trigger it finds new sale emails, takes one unassigned code from the `licenses` table, marks it assigned with the buyer's email, emails the buyer the code and instructions, and labels the thread so it is never reprocessed. It talks to Supabase **directly** (the REST `licenses` table, with the service-role key held in the script's properties). It does **not** call any function in this repo.

Things that must stay true for delivery to keep working:
- the `licenses` columns `code`, `assigned`, `assigned_at`, `buyer_email` and `uses_remaining` keep their names and types;
- the service-role key in the script is kept in sync with the one in Netlify whenever it is rotated;
- the pool never runs dry: **`check-code-supply`** runs daily (`netlify.toml`, `schedule = "@daily"`), and when fewer than `CODE_SUPPLY_THRESHOLD` codes are unassigned it generates `CODE_SUPPLY_BATCH_SIZE` more.

The earlier Zapier-based delivery (an `assign-next-code` endpoint and an `assign_next_license` database function) has been **removed**. It was replaced by the script above and is no longer part of this system.

`templates/delivery-instructions.txt` / `.html` hold buyer instructions text with a `{{CODE}}` placeholder. They are kept as reference copies.

## 5. Releasing this change safely

Order matters. Nothing here changes a license row, a code, or a remaining-uses balance.

1. **Prerequisites (before any deploy):** set `TAILOR_TOKEN_SECRET` in all four Netlify contexts; optionally set the Anthropic spend limit.
2. **Before/after fingerprint** of the license table (aggregate only, no codes or emails):
   ```sql
   select count(*) as rows, sum(uses_remaining) as sum_uses_remaining, sum(max_uses) as sum_max_uses,
          md5(string_agg(code||':'||max_uses||':'||uses_remaining||':'||assigned::text||':'||coalesce(buyer_email,''), ',' order by code)) as fingerprint
   from licenses;
   ```
   Take it before the first step and after each step. It must not change, except for uses you deliberately spend while smoke-testing.
3. Apply migration 01 (additive). Re-take the fingerprint. If the API reports a new function as "not found" right after applying, run `notify pgrst, 'reload schema';` in the SQL editor to refresh Supabase's API cache.
4. Apply migration 02 (the one-statement revoke). Run the privilege check below. Run one generation with your personal test code on the live site, which still works because the server uses the service-role key.
5. Open the code change as a pull request and smoke-test the **Deploy Preview**. Note: previews use the same Supabase credentials as production, so test only with your personal code.
6. Merge. Netlify deploys. Smoke-test production with your personal code. Re-take the fingerprint.
7. Watch Netlify function logs for 401/403 spikes for 48–72 hours, and confirm the next real order is delivered normally.
8. About 72 hours later, delete `netlify/functions/consume-generation.js` in a follow-up change.

**Rollback**
- Code: in Netlify, "Publish deploy" on the previous production deploy. The old page and old functions go back together.
- Migration 02: `grant execute on function public.consume_license_use(text) to public;`
- Migration 01: leave in place. It is additive and unused by the old code. (If you must remove it: `drop table license_reservations cascade;` and drop the five functions.)
- There is no data migration to undo.

### Verify (read-only)

```sql
-- Who can run each function? (expect anon/authenticated = false everywhere, service_role = true)
select p.proname,
       has_function_privilege('anon', p.oid, 'execute')          as anon_can_run,
       has_function_privilege('authenticated', p.oid, 'execute') as authed_can_run,
       has_function_privilege('service_role', p.oid, 'execute')  as service_role_can_run
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' order by 1;
```

## 6. Tests

`tests/` is a separate package, so Netlify builds never install its dependencies. It runs the real handlers against a **disposable local Postgres** (never Supabase) with the AI provider mocked, plus browser tests of the customer page. See `tests/README.md`.

## 7. Manual checklist after a release (use your personal code only)

- Enter a valid code → analyze a resume → counter drops by exactly 1.
- Try Sample → loads with no counter change.
- Tailor to a job after analyzing → works; the counter does **not** change.
- Reload the page and re-enter the same code → server shows the already-reduced count.
- Made-up code → "We couldn't find that code." An exhausted code → "used all generations" with the Etsy link.
- Paste an extremely long resume (over 30,000 characters) → clear "too long" message; counter unchanged.
