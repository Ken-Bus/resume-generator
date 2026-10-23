# Setup and Operations

How the 5-generations-per-code system is set up, how codes reach buyers, and how to release changes to it safely.

## How a generation is charged (read this first)

All billable work happens server-side. The browser never decides whether a generation is allowed.

1. **`parse-resume`** receives the license code and the resume text.
2. It **reserves** one generation in Supabase (`reserve_license_use`). This is atomic, so simultaneous requests can never hold more reservations than uses remain. A code with no uses left, one throttled for repeated costly failures (see below), or with all its remaining uses already in flight, is rejected **before any AI call**.
3. It runs the AI. If the AI errors, times out, is cut off, or returns something that isn't a usable resume, the reservation is **released** and the customer is **not charged**.
4. Only after a validated result does it **commit** the reservation (`commit_license_use`), which decrements `licenses.uses_remaining` exactly once. Commit is idempotent.
5. If the function crashes or is killed mid-call, nobody releases the reservation, but it has a short **lease** (45 s by default) and simply lapses. A failure can never permanently cost a use.
6. A successful parse returns a **signed tailoring token** (HMAC, 2-hour life) tied to that paid generation. **`tailor-resume`** requires it, costs no extra generation, and allows at most 5 runs per paid generation (counted atomically in the database).
7. "Try Sample" loads a static sample in the browser. It makes no AI call. Its preview is watermarked and not printable, and it cannot be downloaded (see 9).
8. **`polish-resume`** ("Polish My Resume with AI", after the guided questions) is charged **exactly like Analyze**: one reservation, one AI call, one commit only after a validated result, release on any failure. **One polish that meaningfully improves the wording = one of the five included generations; a polish that finds nothing meaningful to improve (nothing reworded; capitals, punctuation and spacing alone do not count) is released and costs nothing**, with a separate per-code cap on such requests (`_lib/nochange.js`). It returns the same signed tailoring token, so Tailor stays free, token-gated and capped at 5 runs. It also allows only one paid operation at a time per code, so a double-click or a retry while it runs is rejected uncharged (`_lib/inflight.js`), and an optional `requestId` makes a retry of a finished polish return the same result without a second charge (best-effort, in memory, 5 minutes).
9. **`export-resume`** (PDF and Word downloads) is an **authorization check, not a generation**. The files are rendered **on the server**, and only after the access code is found in the `licenses` table (checked on every request; no bearer token to replay, a deleted code stops working at once). The browser holds no PDF/Word rendering code. It never reserves, commits or releases anything and never calls the AI. A code with all five generations used can still download (the code is the purchase). Bad codes are limited per client and good codes per code (best-effort, in memory: `_lib/rate.js`). The function sends no CORS headers (same-origin only) and never logs codes or resume text. **Resume text now passes through this function to be rendered; it is not stored or logged.**

### Bounded failure protection

Failures are free to the customer, so they must not be free to abuse. Both limits are enforced in the database, under the same row lock as the reservation, so parallel bursts cannot bypass them.

- **Parsing:** a failure that may have cost money (the AI ran but gave nothing usable, or timed out) counts against a **per-code budget of 6 per 15 minutes and 30 per 24 hours**. Past that the code is throttled: no AI call, no charge, HTTP 429 with a "please wait about N minutes" message and a `Retry-After` header. A burst can add at most "uses remaining" failures beyond the budget.
- **Provider outages never count** (HTTP errors or network failures from the AI provider). They cost nothing, so a customer is never penalised for them, however long they last.
- **A paid result already in flight always completes**, even if the code becomes throttled while it runs.
- **Tailoring:** an outage is always given back. Other failed runs are given back **twice per paid generation**; after that a failed run stays used, so a token yields at most 7 AI calls plus any outages.
- These limits bound *failure* cost per code. The AI provider **spend limit** (below) is the overall backstop and is **mandatory**.

`consume-generation` is a **deprecated shim** that reads counts and never writes. It exists only so a browser tab opened before the release is not charged for a call the new server then rejects. Delete it about 72 hours after the release.

## 1. Supabase project

1. Create a free-tier project at supabase.com.
2. For a **new** project: run `supabase/schema.sql` in the SQL editor. It is idempotent and creates the `licenses` table, the reservation table and functions, and applies the lock-down below.
3. For the **existing production** project: do **not** re-run all of `schema.sql`. Apply only the migrations you have approved, **in this order relative to the deploy**:
   - `supabase/migrations/20261020_01_license_reservations.sql` — additive (new table and functions). **Before** the code deploys.
   - `supabase/migrations/20261020_02_revoke_public_execute_consume_license_use.sql` — one `revoke` statement that stops the public `anon`/`authenticated` roles from calling `consume_license_use`. **After** the deploy has been smoke-tested. The new code never calls that function, so applying it last cannot break anything, and applying it earlier would only add risk to the still-running old code for no benefit.
4. In Project Settings → API, copy the **Project URL** and the **service_role** key (not the `anon` key). Nothing in this app uses the `anon` key.
5. **A merged change to `schema.sql` is not live until it is applied in Supabase.** After applying anything, re-run the read-only checks in §5.

The lock-down: `licenses` and `license_reservations` have RLS enabled with **no policies**, and every function is executable only by `service_role` (the key held by Netlify and by the delivery script).

## 2. Netlify environment variables

_No new variables are needed for downloads or AI Polish._ They use the existing `SUPABASE_*`, `ANTHROPIC_API_KEY`, `AI_TIMEOUT_MS` and `TAILOR_TOKEN_SECRET`. The new functions bundle `jspdf` and `docx` (about 19 MB zipped, well inside Netlify's 50 MB function limit; packaging verified with `@netlify/zip-it-and-ship-it`).

Set in Site configuration → Environment variables. `SUPABASE_*` and `ANTHROPIC_API_KEY` must be set in **all four deploy contexts** (Production, Deploy Previews, Branch deploys, Local development), or some code paths will keep running on a stale or missing value. Netlify applies a variable **at deploy time**, so redeploy after changing any of them.

_AI model, thinking setting, caps and the privacy-safe `ai-usage` log: see `docs/AI_MODEL_AND_USAGE.md`. The model is `claude-sonnet-5-5`; no new environment variable is needed._

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | yes | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only key. Never put it in the browser, the repo, or a chat |
| `ANTHROPIC_API_KEY` | yes | AI provider key. A spend limit on it is **mandatory** (§2.2) |
| `AI_TIMEOUT_MS` | **set to `50000`** (§2.3) | Abort an AI call after this long. Must sit below the Netlify function timeout (documented as 60 s) |
| `TAILOR_TOKEN_SECRET` | yes, for tailoring | Random secret, at least 32 characters (§2.1). If missing or short, analysis still works but tailoring is disabled and a warning is logged |
| `TAILOR_TOKEN_SECRET_PREVIOUS` | only during a rotation | The old secret, still **accepted** (never used to sign) so customers are not logged out (§2.1) |
| `CODE_SUPPLY_THRESHOLD` | optional (default 20) | Replenish when fewer unassigned codes remain |
| `CODE_SUPPLY_BATCH_SIZE` | optional (default 100) | Codes generated per replenishment |
| `ALERT_WEBHOOK_URL` | optional | Any HTTP webhook receiver for the zero-supply alert. Unset = only written to the function log |

### 2.1 `TAILOR_TOKEN_SECRET`: generate, configure, rotate

Secret values are never written in this repo, in a pull request, in a chat, in an email or in a screenshot.

- **Generate** on your own computer: `openssl rand -base64 48` (or your password manager's random generator, 48+ characters). Copy it straight into Netlify. Do not reuse any other key.
- **Configure** in Netlify: Add a variable named `TAILOR_TOKEN_SECRET`; mark it as a **secret** (write-only) and scope it to **Functions**. Use a **different random value** for Production and for Deploy Previews. Branch deploys and Local development may stay unset: tailoring is then simply disabled there and analysis still works. (Menu wording may differ slightly between Netlify plans.)
- **Check without exposing it:** the smoke test's Tailor step works, and the function log contains no "TAILOR_TOKEN_SECRET is missing" warning. The code never logs the value.
- **Rotate (planned, no customer impact):**
  1. Generate a new value.
  2. Set `TAILOR_TOKEN_SECRET_PREVIOUS` = the current value, and `TAILOR_TOKEN_SECRET` = the new value.
  3. Redeploy; confirm tailoring still works (smoke test with your personal code).
  4. After **at least 2 hours** (the token lifetime), delete `TAILOR_TOKEN_SECRET_PREVIOUS` and redeploy.
- **Emergency (suspected exposure):** set a new `TAILOR_TOKEN_SECRET`, do **not** set a previous one, redeploy. Every outstanding token dies at once; affected customers must analyze again, which costs them a use, so restore it on request (§5, "Data").
- **Rollback:** code from before this release ignores both variables, so leaving them set is harmless.

### 2.2 AI provider spending controls (mandatory before release)

- In the Anthropic Console, set a **monthly spend limit** and email alerts (for example at 50% and 80%). Size it from the Console's usage page; start conservative, since raising it is easy and an unbounded bill is not.
- Give this application its **own key** (and, ideally, its own workspace) with a descriptive name and creation date, so it can be rotated or revoked without touching anything else.
- Record the limit, the alert thresholds and the key's name/date somewhere private. Do not proceed to §5 until this is done.
- After release, check the usage page daily for a week. Expected volume is about one AI call per analysis plus one per tailoring run, which should track your Etsy sales. Anything much higher is a signal to stop and investigate.

### 2.3 AI timeout: `AI_TIMEOUT_MS` (recommended value: 50000)

- Netlify's current documentation lists **60 seconds** for synchronous functions and says it is **not configurable**. (Older posts mention 10 s, or 26 s on request, and one 2025 support guide says 30 s.) This project sets no function timeout of its own, so the platform default applies. The live app already runs analysis and tailoring, whose AI output takes well over 10 seconds, so the old 10-second figure is unlikely to apply.
- **Set `AI_TIMEOUT_MS` to `50000`** (Production and Deploy Previews). That leaves about 10 seconds for start-up, the database calls and the response, and the reservation lease adjusts automatically (to 70 seconds).
- **Still set it explicitly in Netlify.** The code's built-in fallback is also `50000` (so a forgotten variable cannot cut off longer resumes: a 2–3 page resume's analysis can take 25–45 seconds), but an explicit value is visible and auditable.
- **Why set it high rather than low:** if it is set too low, long analyses fail cleanly but *every time*, which is a regression for paying customers. If the platform's real limit turns out lower than the value, a long analysis is killed by the platform instead. It is still not charged (the lease lapses) and behaves as it did before this release.
- **If Netlify logs ever show "Task timed out after N seconds":** that N is the real limit. Set `AI_TIMEOUT_MS` to `N × 1000 − 4000` (for example 26 → `22000`) and redeploy.
- **During the 24-hour watch**, search the function logs for "timed out" and for `reason: 'timeout'`. A few are normal (very long or slow outputs; uncharged). A pattern means adjusting the value.

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

## 5. Release runbook

Nothing here changes a license row, a code, or a remaining-uses balance. **Use only your own personal test code for anything that spends a use. Never use a customer's code.**

### Gates (all must be true before step 1)

| Gate | Check |
|---|---|
| G1 | AI provider **spend limit and alerts** set and recorded (§2.2) |
| G2 | `AI_TIMEOUT_MS` set to **50000** in Production and Deploy Previews (§2.3) |
| G3 | `TAILOR_TOKEN_SECRET` set for Production and Deploy Previews, different values (§2.1) |
| G4 | A **new** AI key created and set in all four contexts. The currently live site keeps its old key until redeployed, so nothing changes yet |
| G5 | Your personal code has **at least 2 uses left** (check below) |
| G6 | Baseline fingerprints taken (below) and saved |
| G7 | The current production deploy is identified in Netlify as the **known-good rollback target**, and will not be deleted |
| G8 | The superseded-deployments check is done (kept privately, not in this repo) |
| G9 | Netlify **auto-publishing is locked** (Deploys → **Stop auto publishing**), so merging builds the new deploy but does **not** publish it. With auto-publishing on, merging to the production branch publishes immediately, before any smoke test |

### Read-only queries

```sql
-- Full fingerprint (aggregate only: no codes, no emails)
select count(*) as rows, sum(uses_remaining) as sum_uses_remaining, sum(max_uses) as sum_max_uses,
       md5(string_agg(code||':'||max_uses||':'||uses_remaining||':'||assigned::text||':'||coalesce(buyer_email,''), ',' order by code)) as fingerprint
from licenses;

-- Customers-only fingerprint: excludes YOUR personal code. It must not change during the release, except for a real order
-- delivered by the Apps Script meanwhile (see the smoke-test check 4).
select count(*) as rows, sum(uses_remaining) as sum_uses_remaining,
       md5(string_agg(code||':'||max_uses||':'||uses_remaining||':'||assigned::text||':'||coalesce(buyer_email,''), ',' order by code)) as fingerprint
from licenses where code <> '<YOUR_PERSONAL_CODE>';

-- G5: your personal code's balance
select uses_remaining from licenses where code = '<YOUR_PERSONAL_CODE>';

-- Who can run each function? (expect anon/authenticated false everywhere; service_role true)
select p.proname,
       has_function_privilege('anon', p.oid, 'execute')          as anon_can_run,
       has_function_privilege('authenticated', p.oid, 'execute') as authed_can_run,
       has_function_privilege('service_role', p.oid, 'execute')  as service_role_can_run
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' order by 1;

-- Reservations in flight right now (should be 0 before the smoke test)
select count(*) from license_reservations where status = 'reserved' and expires_at > now();
```

### Sequence

1. **Apply migration 01.** Verify: the privilege query shows every function server-only; `license_reservations` exists; **both fingerprints unchanged**; `select count(*) from license_reservations` is 0 (no real order in between, or explain it as in smoke-test check 4). If the API reports a new function as "not found", run `notify pgrst, 'reload schema';`.
2. **Deploy Preview: non-mutating checks only** (below).
3. **Merge** (you). Because auto-publishing is locked (G9), Netlify builds the production deploy but does **not** publish it: the live site keeps running the old code. Wait until the build shows **Ready**.
4. **Production smoke test on the unpublished deploy** (below): open that deploy's own link from its summary page. It runs the new code with the Production environment and the real database. If any abort condition occurs, **do not publish**: the live site is untouched and there is nothing to roll back.
5. **Publish deploy** (that deploy's summary page → **Publish deploy**). Re-check the live site with the zero-AI negative checks only (no paid generation). Then **Start auto publishing** so later changes deploy normally. Do not forget this step: while locked, no future merge goes live.
6. **Apply migration 02.** Verify: the privilege query now shows `consume_license_use` server-only; **customers-only fingerprint unchanged** (apart from a real order, as in smoke-test check 4).
7. **Watch for at least 24 hours (up to 72):** Netlify function logs for 401/403/429/503 spikes, the AI usage page against your sales, and confirm the next real order is delivered normally.
8. **Cleanup of superseded deployments and the old AI key**, using your private checklist. Revoke the old AI key **last**, after the watch window (see Rollback for why).
9. Follow-up change: delete `netlify/functions/consume-generation.js`; update the Founder OS notes.

### Deploy Preview: non-mutating checks only

Netlify builds a Deploy Preview for every pull request, and **previews use production credentials**. Anything that spends a use or writes data on a preview is a production change, so previews get only checks that write nothing (verified by the test suite: the checks below leave the license fingerprint unchanged and add zero reservation rows):

1. The page loads and shows the access-code gate.
2. Click "Try a free sample". The browser's Network tab must show **no** request to `/.netlify/functions/*`, and the sample resume appears.
3. Enter a malformed code (`abc`): the "doesn't look right" message appears.
4. Enter a well-formed but made-up code (`FG-ZZZZ-9999`): "We couldn't find that code."
5. With the sample loaded, click PDF or Word: the access-code gate appears and the Network tab shows **no** request to `/.netlify/functions/*`. The preview shows a "SAMPLE PREVIEW" watermark.
6. **Do not** enter any real code (customer or personal) on a preview, and do not press Analyze, Polish or a download with one.

### Production smoke test (minimal, personal code only)

**Exactly one paid generation is spent, on your personal code, and nothing else changes.**

- **Where and when:** on the **unpublished** production deploy (its own link), before it is published, in a quiet period.
- **Input:** a **3-line fake resume** (no real personal data) for **one Analyze**, then a **1-line job description** for **one Tailor**. That is **2 AI calls**. Only the Analyze spends a paid generation; the Tailor spends none.
- **Capture BEFORE you start (read-only)**, and write the answers down:
  ```sql
  select now() as test_start_utc;                                                   -- the clock reference for every check below
  select uses_remaining as before_uses from licenses where code = '<YOUR_PERSONAL_CODE>';
  select count(*) as reservations_before from license_reservations where code = '<YOUR_PERSONAL_CODE>';   -- expect 0
  ```
  Plus the customers-only fingerprint from "Read-only queries". (If you would rather not type your code: it is the only row with `assigned = true and buyer_email is null`. Stop and ask if more than one row matches.)
- **Checks AFTER the test (all must hold):**
  1. **Your personal code:** `uses_remaining` = `before_uses − 1`. Exactly one, not two.
  2. **Your reservations:** exactly **one** new `license_reservations` row for your code, with status `committed` and `tailor_count = 1`, and **none** in `reserved`, `released` or `expired` since the start.
  ```sql
  select status, tailor_count, count(*) from license_reservations
   where code = '<YOUR_PERSONAL_CODE>' and created_at >= '<test_start_utc>' group by 1, 2;    -- expect exactly: committed | 1 | 1
  ```
  3. **No other code spent anything:**
  ```sql
  select count(*) from licenses where code <> '<YOUR_PERSONAL_CODE>' and last_used_at >= '<test_start_utc>';   -- expect 0
  ```
  4. **No customer record changed:** the customers-only fingerprint equals the one you captured. The one legitimate exception is a **real order delivered by the Apps Script during your test** (it assigns a code and sets a buyer email). Check it with `select count(*) from licenses where assigned_at >= '<test_start_utc>';`: **0** means nothing happened, so any fingerprint change is a failure; **1** means a real order was delivered, which is expected and not a failure (re-capture the baseline and continue). Any other change is a failure.
  5. **No permission or schema change:** the privilege query gives the same answer as after migration 01 (migration 02 has **not** been applied yet).
  6. **Other customers are fine to appear:** a real customer using the site during the test adds reservation rows **for their own codes**. Those are expected and are never part of this check.
- **Downloads (no writes, no AI):** with the same personal code, download one PDF and one Word file from the Edit Fields tab; `uses_remaining` and the reservation rows must not change. (Do **not** press Polish in the smoke test: it would spend a second generation.)
- **Also check (zero AI calls, no writes):** a made-up code and a missing code are refused with friendly messages; the Netlify function log shows no `TAILOR_TOKEN_SECRET` warning; the AI provider's usage page shows **2** new calls from your test (any extra calls are real customers).
- **Abort and roll back if:** Analyze with your valid code fails or runs longer than the timeout you recorded; the counter drops without a result, or by more than 1; any of checks 1–5 fails; the function log shows `reserve_license_use is missing` (migration 01 was not applied) or repeated 5xx.

### Rollback

| Situation | Action | Notes |
|---|---|---|
| Problem found **before** publishing | Do not publish. The live site never changed | The cheapest rollback there is. Leave auto-publishing locked until it is fixed |
| Problem with the new code **after** publishing (any time in the watch window) | Netlify → Deploys → the recorded known-good deploy → **Publish deploy** | The old code works with the database in all three states: before migration 01, after 01, after 01+02 (checked in the test suite). The old deploy carries the **old AI key**, so that key must stay valid until the window ends. |
| Problem after migration 02 | `grant execute on function public.consume_license_use(text) to public;` | Restores the original grants. |
| Problem with migration 01 | Roll the **code** back first. Leave migration 01 in place: it is inert for the old code. Drop its objects only if you must, and never while the new code is live (it would fail closed with a 503 and no charge). | |
| Secret problem | See §2.1 (rotate / emergency) | |
| **After the old AI key has been revoked** | Do **not** "Publish deploy" an older deploy expecting AI to work: it holds the revoked key. Fix forward, or set the new key and redeploy from Git. | This is why the old key is revoked last. |
| **Data** | There is no data migration. Balances are only written by `commit_license_use` (new) and `consume_license_use` (old) on the same column, and reservations are disposable. If a customer reports a lost use, confirm it in `license_reservations`, then: `update licenses set uses_remaining = least(uses_remaining + 1, max_uses) where code = '<CODE>';` | |

## 5b. Branch-deploy acceptance test (before merging a feature branch)

A **branch deploy** builds a pushed branch at its own URL (`<branch>--<site-name>.netlify.app`) without publishing it to production. It uses the **"Branch deploys"** environment-variable context and, here, the **production database**, so treat it as production data with a non-production URL.

**Before the first build** (variables apply at deploy time):

| Variable (Branch deploys context) | Value |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Same as production (server-only; mark as secrets). Without them every function fails. |
| `ANTHROPIC_API_KEY` | Same as production, or a separate key with its own spend limit that you revoke afterwards. Without it Analyze, Polish and Tailor return "Server error". |
| `AI_TIMEOUT_MS` | `50000` |
| `TAILOR_TOKEN_SECRET` | A **new** random value (32+ characters), **not** the production one. Both environments share one database, so a shared secret would let a token from the branch be honored on production. Without it Polish still charges but issues no Tailor token. |

**Safety:**
- Enable branch deploys for **individual branches only** (the one under test), not "All".
- Use only your personal code; never a customer's. Polish spends 1 of its 5 generations, so confirm it has at least 3 left first.
- Keep production auto-publishing locked.
- Scheduled functions (`check-code-supply`) run only on the published production deploy.

**If Netlify offers no Retry/Redeploy for a branch deploy,** push a documentation-only commit to the branch: any push builds it again, with the environment variables as they are at that moment.

**Variables are read when the deploy is BUILT.** Adding or fixing one afterwards changes nothing until you redeploy that branch ("Trigger deploy", "Clear cache and deploy site"). A missing `ANTHROPIC_API_KEY` is the commonest cause of "Server error, please try again. (ref P101)" on a branch deploy: the function stops before it reserves anything, so nothing is charged.

**Free configuration check from the browser console on the branch site** (spends nothing, reads no data, shows no secrets):
```js
fetch('/.netlify/functions/polish-resume',{method:'POST',body:'{}'}).then(r=>r.status)   // 500 = AI key missing for this deploy; 401 = present
fetch('/.netlify/functions/tailor-resume',{method:'POST',body:'{}'}).then(r=>r.status)  // 500 = AI key missing; 503 = TAILOR_TOKEN_SECRET missing/short; 401 = both present
```

**Publication and security-header checks (free; do these on the branch deploy BEFORE anything else):** the repository root is published, so these paths must answer 404 and the page must still load. In a terminal (replace the host):
```
for p in /SETUP.md /package.json /netlify.toml /supabase/schema.sql /scripts/generate-codes.js /lib/codes.js /docs/AI_POLISH.md /tests/package.json /netlify/functions/polish-resume.js /netlify/functions/_lib/integrity.js /templates/delivery-instructions.html; do printf '%s ' $p; curl -s -o /dev/null -w '%{http_code}\n' https://<branch>--<site>.netlify.app$p; done   # every line must end in 404
for p in / /index.html /wizard.js /resume-core.js /templates.js; do printf '%s ' $p; curl -s -o /dev/null -w '%{http_code}\n' https://<branch>--<site>.netlify.app$p; done                                           # every line must end in 200
curl -sI https://<branch>--<site>.netlify.app/ | grep -iE 'content-security-policy|x-frame-options|referrer-policy|permissions-policy|x-content-type-options'                                              # all five present
```
Then open the page with the browser console open and click through the gate, the guided builder and Try Sample: there must be **no** "Refused to ..." / Content-Security-Policy messages. If the page breaks, remove the `Content-Security-Policy` line from `netlify.toml` and redeploy; the other protections do not depend on it. Also open `https://<site>/.netlify/functions/check-code-supply` once (production after release is side-effect free when 20 or more codes remain; on a branch deploy it uses the production database): it should not return a code count to an anonymous visitor (see `docs/CODE_SUPPLY_EXPOSURE.md`).

**Which build is serving? (free; do this before every paid test, no Console needed).** Open `https://<branch-site>/.netlify/functions/polish-resume` in a browser tab. It shows `{"error":"Method Not Allowed","guard":{"version":"entry-scope-withhold-4",...}}` (a plain visit is a GET: it never reaches a licence, a reservation or the AI). That is the SERVER's version. The page's version: Console `ResumeCore.GUARD_VERSION` (or open `/resume-core.js` and search for `GUARD_VERSION`). Both must show the current value. A plain `Method Not Allowed` with no `guard` means an older deploy is serving. Also confirm in Netlify > Deploys that the branch's published deploy is the latest commit. A `401` in the Network tab from a POST with no code is normal and means "no access code".

**Zero-cost checks right after the build (no generation spent):**
1. Enter `FG-ZZZZ-9999` at the gate: "We couldn't find that code." (proves the Supabase variables work).
2. Open `/.netlify/functions/export-resume` and `/.netlify/functions/polish-resume` in the browser: each answers "Method Not Allowed" (proves the functions deployed).
3. Click Try Sample, then PDF: the access-code gate appears and nothing downloads.

**Then, with your personal code:** download a PDF and a Word file (counter unchanged); run one Polish (if it improves the wording the counter drops by exactly 1 and AI-added lines are yellow; if the page says "No meaningful improvements were found" or "The AI's suggestions were not used" the counter must not move, and the Netlify log shows ref P201 or P202; any "left out" list must name where and why without showing AI text); run one Tailor (works, counter unchanged); repeat a build and a download on a phone.

**Cleanup:** remove the branch from the branch-deploy list, delete the branch-only `TAILOR_TOKEN_SECRET`, and revoke any test API key.

### Reading a "Server error ... (ref XXXX)" message

Customers see a friendly message with a short reference. The same reference is written to the Netlify function log next to the reason (never a code, a secret or resume text), so you can tell what happened without guessing. In every case below **nothing is charged and no reservation is left held**.

| Ref | Function | Meaning | Usual fix |
|---|---|---|---|
| P101 | polish-resume | `ANTHROPIC_API_KEY` is not set for this deploy's context | Add it for that context, then redeploy |
| P102 | polish-resume | Database settings (`SUPABASE_URL` / key) missing | Add them for that context, then redeploy |
| P103 | polish-resume | The reservation call to the database failed | Check Supabase status; confirm migration 01 is applied |
| P104 | polish-resume | The database returned an unexpected reservation answer | Check the function log; report it |
| P105 | polish-resume | The duplicate-request check failed (the reservation is released) | Check Supabase status / table access for `service_role` |
| P106 | polish-resume | The AI finished but the charge could not be recorded (released, uncharged) | Check the counter, then try again |
| P107 | polish-resume | Our own integrity check failed on the AI's answer (released uncounted, nothing charged, no AI text shown) | Report it: the function log has the reason code |
| P201 | polish-resume | Not an error: the AI found nothing meaningful to improve (unchanged, capitals only, or only one-word touch-ups); the reservation was released and nothing was charged | None. Counts only are logged (reworded / minor / cosmetic / unchanged / dropped) |
| P202 | polish-resume | Not an error: every change the AI suggested was withheld by the integrity checks (borrowed detail, inflated role, added beneficiary or result, blank filled in); released, nothing charged | None. Counts only are logged. A pattern may mean the prompt needs another look |
| A107 | parse-resume | Our own check failed on the parsed resume (released uncounted, nothing charged) | Report it |
| A201 | parse-resume | Not an error: contact details or dates the AI produced were not in the pasted text and were removed | None |
| T107 | tailor-resume | Our own integrity check failed (the run is given back, nothing charged) | Report it |
| E101 | export-resume | The license lookup failed | Check Supabase status and the database settings |
| E102 | export-resume | The file could not be rendered | Check the function log; report it |

Where to look: Netlify, Logs & metrics, Functions, the function name, the latest invocation. Lines start with `polish-resume:` or `export-resume:`.

## 6. Tests

Run `npm install` at the repo root first (the export function's `jspdf` and `docx` are real dependencies, installed by Netlify at build time) and again in `tests/`. `tests/` is a separate package, so Netlify builds never install its dependencies. It runs the real handlers against a **disposable local Postgres** (never Supabase) with the AI provider mocked, plus browser tests of the customer page. See `tests/README.md`. Run them before every release.

## 7. After a security release: older deployments

Treat every older deployment of this site as **live until proven otherwise**. Netlify keeps each deploy (and each Deploy Preview) reachable at its own URL, running the function code and the environment it was built with, and deleting one deployment does not disable any other. After a security release, rotate the AI provider key (revoking the old one, last) and work through a private inventory of older deployments. Keep that inventory out of this repository.
