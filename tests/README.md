# Regression tests

These tests protect the license accounting: five paid generations per code, no charge for failed AI calls, safe behavior under simultaneous requests and crashes, signed tailoring authorization, and the customer page.

They never touch Supabase, Anthropic, Etsy, Gmail or the Apps Script:
- `db/` and `functions/` run the **real SQL and real Netlify handlers** against a **disposable local Postgres**, with the AI provider mocked (including timeouts, truncation and bad output). `db/live_snapshot.sql` reproduces the production database as it was before the reservation migrations, so the migrations are proven against the real starting point.
- `ui/` drives the real `index.html` in headless Chromium with every endpoint mocked. `ui/guided.test.js` covers the guided builder, all 12 templates, mobile layout, and the PDF/Word exports (PDF text is read back with `pdftotext` when installed, and always by inflating the PDF's own streams).
- `functions/export.test.js` proves downloads are server-authorized (unlicensed, invalid, tampered, rate-limited, CORS, logs) and that PDF/Word text is real for all 12 templates; `functions/polish.test.js` proves polish charges exactly one generation and every failure, retry and duplicate is handled; `ui/access-polish.test.js` covers the gate, watermark, print lock, offline/refresh behaviour and the polish click-through.
- `core/` unit-tests the shared section model (`resume-core.js`); `functions/integrity.test.js` covers the tailoring fabrication guard.

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
