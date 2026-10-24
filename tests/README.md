# Regression tests

These tests protect the license accounting: five paid generations per code, no charge for failed AI calls, safe behavior under simultaneous requests and crashes, signed tailoring authorization, and the customer page.

They never touch Supabase, Anthropic, Etsy, Gmail or the Apps Script:
- `db/` and `functions/` run the **real SQL and real Netlify handlers** against a **disposable local Postgres**, with the AI provider mocked (including timeouts, truncation and bad output). `db/live_snapshot.sql` reproduces the production database as it was before the reservation migrations, so the migrations are proven against the real starting point.
- `ui/` drives the real `index.html` in headless Chromium with every endpoint mocked. `ui/guided.test.js` covers the guided builder, all 12 templates, mobile layout, and the PDF/Word exports (PDF text is read back with `pdftotext` when installed, and always by inflating the PDF's own streams).
- `functions/export.test.js` proves downloads are server-authorized (unlicensed, invalid, tampered, rate-limited, CORS, logs) and that PDF/Word text is real for all 12 templates; `functions/polish.test.js` proves polish charges exactly one generation and every failure, retry and duplicate is handled; `ui/access-polish.test.js` covers the gate, watermark, print lock, offline/refresh behaviour and the polish click-through.
- `core/` unit-tests the shared section model (`resume-core.js`); `functions/integrity.test.js` covers the tailoring fabrication guard.

## The release run (`npm run test:release`)
`npm test` is the quick developer run: if Postgres or Chromium is missing, those suites **skip**, and a skipped suite looks green. `npm run test:release` is the gate: it refuses to start without a local Postgres and a Chromium, and it **fails if anything at all was skipped**, failed or cancelled. Chromium is found automatically (newest `chromium-*` under `PLAYWRIGHT_BROWSERS_PATH`, `/opt/pw-browsers` or `~/.cache/ms-playwright`; override with `CHROMIUM_PATH` / `PLAYWRIGHT_MODULE`). A release is judged on this run, never on `npm test`.

## Run

```
npm install            # repo root: the export function needs jspdf and docx
cd tests
npm install
npm test
```

If no local Postgres is reachable, the DB-backed tests are **skipped** (not failed). To start a disposable one (Linux; adjust paths):

```
sudo mkdir -p /home/user/pgtest && sudo chown postgres /home/user/pgtest
sudo -u postgres /usr/lib/postgresql/16/bin/initdb -D /home/user/pgtest/data -A trust
sudo -u postgres /usr/lib/postgresql/16/bin/pg_ctl -D /home/user/pgtest/data -o "-p 5544 -k /home/user/pgtest -c listen_addresses=''" -l /home/user/pgtest/pg.log -w start
```

Environment overrides: `TEST_PG_HOST` (socket dir), `TEST_PG_PORT`, `TEST_PG_USER`, `PLAYWRIGHT_MODULE`, `CHROMIUM_PATH`.

Never point these tests at a real Supabase project.

## Release-hardening suites
- `functions/release-matrix.test.js`: first-time, long-time, career-changer, sparse, complete and long resumes against faithful, unchanged, capitals-only, deletion-only, borrowed, inflated, invented, hostile-shape and prompt-injection AI answers for Polish and Tailor (real SQL: charge, release, throttle); Analyze grounding; size limits and timeouts; concurrency, retries, commit/release failures; log privacy; and every person x 12 templates x PDF and Word.
- `functions/publication.test.js`: only five files are public, everything else is a forced 404, headers and CSP policy, no secrets in public files.
- `functions/integrity-scope.test.js`, `functions/model-usage.test.js`, `functions/nochange.test.js`: the entry-scoped checks, the model/usage log, and the free-attempt cap.
- `ui/release-hardening.test.js`: real Chromium **with the production security headers enforced**: one AI step at a time, Restore correctness, Analyze overwrite confirmation, what the customer sees for withheld suggestions, hostile text, sparse resumes, exports, and 375x667 / 320x568 phones (no sideways scroll, 16px inputs, 40px tap targets). Any page error or policy violation fails the test.

## QA campaign suites (2026-10-23)
- `functions/scoring.test.js`, `functions/collective-charge.test.js`: the owner-approved 3-point charging rule, as a pure function and through the real handler and real SQL (0/1/2/3+ point boundaries, rejected material earning nothing, the same fix counted once, retries, duplicates, the last credit, the free-attempt cap).
- `functions/guard-accuracy.test.js`: the factual guard in BOTH directions on a corpus written independently of it (honest edits kept, invented lines withheld, known strictness asserted, stemmer pairs, skills, the headline, a line copied across entries).
- `functions/analyze-guard.test.js`: Analyze is one-at-a-time and replay-safe like Polish; guessing limits on every endpoint that takes a code; no code in a log; timeout wording.
- `functions/code-supply.test.js`: the scheduled code top-up reveals no inventory counts in its response.
- `ui/work-safety.test.js`: the customer's work survives a reload, a reload during a paid step, a lost reply, and blocked browser storage; the leave-page question; the Guided Builder returns to its step; the first polish's wording stays restorable.

## Durable duplicate-charge suites (migration 03)
- `functions/durable-idempotency.test.js`: independent "instances" (freshly loaded handlers with empty memory and their own connection pool) against one real Postgres. A charged Analyze or Polish whose reply is lost and retried on a cold instance is not charged again and is re-delivered; changed input or another request id is a new step; failed re-delivery gives its turn back; simultaneous retries produce one re-delivery; limit of three; a request id is never honoured for another code; only two hashes are stored (privacy); an older page without request ids behaves as before; new code against a database without migration 03 answers 503 and charges nothing; provider 429/529 is a calm "very busy" message with no server-side retry.
- `db/reservations.test.js` also proves migration 03 applies twice, keeps the 5-argument call working, leaves license rows untouched, is server-only, and that `schema.sql` and the migrations end in the same shape.

## Migration 03 hardening suites (revision 2)
- `db/reservations.test.js`: the full decision table of `reserve_license_use` with a request key (replay, busy, limit, **conflict**, **expired**), retention at the boundary (23 h 59 m, 24 h 1 m, 400 days), abandoned and failed leases, concurrent identical and conflicting retries, the daily purge.
- `db/migration03-review.test.js`: original production code on four database states, permissions, migration under load, crash/restart, rollback and roll-forward, and the runbook itself (the preflight file is read-only and identifies every state; the no-AI smoke test behaves as documented).
- `functions/compat-matrix.test.js`: previous application (from git history) and this branch against every database state.
- `functions/durable-idempotency.test.js`: independent instances: conflicts, stale tab, overlap, retention, limit, leases, fault injection, recovery honesty, unauthorized roles, privacy.
- `ui/recovery.test.js` (Chromium): what the customer sees and can do next for recovered results, refusals, the recovery limit and a failed recovery.

## Local drafts and temporary encrypted recovery suites (migration 04)

- `tests/db/result-recovery.test.js`: real SQL; atomic charge + copy, scoping, 24 h ceiling, expiry on read, purge, rollback.
- `tests/functions/result-recovery.test.js`: handlers; fail-closed without the key or migration, exact-copy replay, unauthorized/guessing/rate limits, no sensitive logging.
- `tests/ui/drafts.test.js`, `tests/ui/restore-result.test.js`: Chromium (desktop and Android viewport); autosave, newer-wins, blocked storage, no credentials in drafts, Restore my result.
- Do not run suites concurrently (they share one local PostgreSQL and timing-sensitive limiters).
