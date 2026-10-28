# Tailoring authorised by the access code (migration 06)

Status: prepared for review on branch `feature/tailor-access-by-code`. Not pushed, not applied to production, not deployed.

## Policy (owner-approved)
- Up to 5 Tailor runs per qualifying paid step stays. A qualifying step is an Analyze or a Polish that used a generation. An included Polish adds none: it shares its parent Analyze's five.
- Tailor never uses a generation. Unused runs no longer disappear after two hours, a closed browser or a new day.
- Allowed while the code is active and during the 96-hour completion period. Refused (403, header `X-Access-State: ended`) once access has ended, with no AI call.
- Etsy code assignment and delivery are unchanged. No change to generations, the included Polish or existing resume data.

## How it works
- `tailor-resume` accepts the customer's access code. After the usual input checks it asks `license_access_status` (ended is refused) and then calls `consume_tailor_for_code(code, 5)`.
- That function locks the code's license row, so parallel requests of one code run one at a time. It picks the oldest committed, non-included step of THAT code with `tailor_count < 5`, adds one, and returns the step. A failed AI call is given back to the same step with the existing `refund_tailor_use` (outage always, other failures forgiven twice per step).
- `tailor_runs_available(code, 5)` is read-only. Sign-in (`verify-license`) and each tailor response return `tailorRunsAvailable`, shown on the page as "N tailoring runs left".
- The runs themselves were always in the database (`license_reservations.tailor_count`). Only the permission to ask for one was the two-hour token.

## Compatibility
- The signed token path is untouched. A page open from before the release, or a request with only a token, behaves as before. With both, the code wins.
- New build on a database without migration 06: falls back to the token path; with no valid token it answers 401 or 503 and uses nothing.
- Apply migration 06 (needs 03 to 05) BEFORE deploying this build. Rollback: drop the two functions.
- No `GUARD_VERSION` change; integrity rules are unchanged.

## Tests added (focused)
- `tests/db/tailor-by-code.test.js` (real SQL): own runs only, 5 per step, oldest first, included Polish excluded, parallel safety, refunds, no balance change, privileges, idempotent, rollback, requires migration 05.
- `tests/functions/tailor-by-code.test.js` (real handlers and SQL): no token or secret needed, expired token ignored, cross-code isolation, sixth run refused, parallel, completion period allowed, ended refused with zero AI calls, fallback without migration 06, privacy of logs, rate limit on guessing.
- `tests/ui/tailor-by-code.test.js` (Chromium, mocked): works with no token, runs-left note, all runs used, older server, ended.
- Existing token, failure-budget, privacy and 5-run suites are reused unchanged and run on a database that has migration 06.

## Wording to change when this ships
- The listing and FAQ line "available for about 2 hours" becomes "available while your access is open". "Up to 5 per Analyze or per Polish that uses a generation" stays.
