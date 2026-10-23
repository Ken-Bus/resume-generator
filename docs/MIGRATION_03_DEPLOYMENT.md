# Migration 03: durable duplicate-charge protection (NOT applied to production)

File: `supabase/migrations/20261023_03_request_idempotency.sql` (also mirrored at the end of `supabase/schema.sql`).
Status: designed and tested against local PostgreSQL only. **It must not be applied to production without the owner's explicit approval.**

## What it fixes
Before: the "same request again" protection was an in-memory cache on one serverless instance. If the reply to a successful, charged Analyze or AI Polish was lost and the retry reached another or a restarted instance, it was a new request and charged a second generation.
After: the committed reservation stores two SHA-256 hashes (the page's request id, and the request's input). The retry is matched under the license row lock, answered `replay`, and **never reserves or charges**. The server then re-delivers the result by running the AI once more (nothing of the customer's text is stored; a re-delivery is limited to 3 per paid step, one at a time, and a failed one gives its turn back).

## What changes in the database (additive)
- 4 new columns on `license_reservations`: `request_key`, `input_hash`, `redelivery_count`, `redelivering_until` (+ one partial index).
- `reserve_license_use` is replaced by a 7-parameter version (the first 5 unchanged, 2 new with defaults); one new function `finish_redelivery`. Both server-only (`service_role`), like every other function; table remains closed to `anon`/`authenticated` (tested).
- No `licenses` row is touched (tested: fingerprint before and after).

## Compatibility with the code that is deployed today
- Old code calls `reserve_license_use` with its 5 named parameters: still works, the new ones default to null, behaviour identical (tested).
- Old code never sends a key, so it never sees `replay*` outcomes.
- **New code against a database WITHOUT the migration:** a request that carries a request id gets a calm 503 "try again" and is not charged (tested); a request without a request id works as before.
- Therefore the order below is safe in both directions; the only unsafe order is code first, migration later (customers see "try again" until the migration is applied).

## Deployment order (when approved)
1. **Backup**: in Supabase, take a backup / note the point-in-time-recovery timestamp. Export `licenses` and `license_reservations` (CSV) for safekeeping.
2. Apply migration 03 in the Supabase SQL editor of the Resume project (one transaction, idempotent; safe to re-run).
3. Verify in the SQL editor: `select proname, pronargs from pg_proc where proname in ('reserve_license_use','finish_redelivery');` expects `reserve_license_use` = 7 and one row only.
4. Deploy the Netlify branch (this feature branch merged by the owner).
5. Check `/.netlify/functions/polish-resume` reports the expected guard version, run one generation on a personal code, then confirm in the SQL editor that the newest `license_reservations` row has `request_key is not null`.

## Rollback / forward recovery
- Code rollback: redeploy the previous Netlify deploy. It keeps working against the migrated database (compatibility above). **No data change is needed.**
- Database rollback (only if the migration itself misbehaves): `drop function reserve_license_use(text,integer,integer,integer,integer,text,text); drop function finish_redelivery(uuid,boolean);` then re-run `20261020_01_license_reservations.sql` (recreates the 5-argument function, idempotent). The new columns are inert and may stay. In-flight reservations and committed charges are untouched.

## Customer-impact risks
- During step 2 the function is replaced inside one transaction; a request arriving in that instant waits for the lock rather than failing.
- A re-delivery uses one extra AI call (cost to Flex & Grace, not to the customer), at most 3 per paid step; the result may be worded slightly differently from the lost one.
- A repeat after 60 minutes is treated as a new step (the key window) and would be charged normally; the page keeps the same request id only for the same unfinished step.
- If the same step is re-delivered 3 times without success the customer is told to message us with their code; nothing more is charged.
