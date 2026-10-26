# `check-code-supply`: possible public exposure

**Status: not changed. Needs one free check (below) before deciding.**

## What it is
`netlify/functions/check-code-supply.js` is scheduled `@daily` (`netlify.toml`). It counts unassigned access codes and, if fewer than `CODE_SUPPLY_THRESHOLD` (20) remain, inserts `CODE_SUPPLY_BATCH_SIZE` (100) more so Etsy delivery never runs out. It has **no authentication check** and answers `{ "generated": n, "remaining": n }`.

## What is and is not at risk if an anonymous visitor can call it as a URL
| Question | Answer |
|---|---|
| Can a visitor read license codes? | **No.** Only a count is returned. |
| Can a visitor create unlimited codes? | **No.** It generates only when fewer than 20 are unassigned, and then 100 at a time; once topped up it does nothing. A visitor can at most trigger the top-up we want anyway. |
| Can a visitor spend AI money? | **No.** No AI call. |
| What leaks? | The size of the unassigned code inventory (a business metric) and the fact the endpoint exists. |
| Other cost | Repeated calls cause a cheap database count each. |

So this is a **low** severity information/hygiene issue, not a security breach path.

## Is it reachable? (free check, 30 seconds)
Netlify is documented to run scheduled functions only on the published production deploy (`SETUP.md` section 5b). Whether the same function also answers a plain HTTP request on production, or on a branch deploy, has **not been verified from here**: this environment cannot reach the deploys.

In a browser or `curl`:
- `https://<production-site>/.netlify/functions/check-code-supply`
- optionally `https://<branch>--<site>.netlify.app/.netlify/functions/check-code-supply`

Caution for the branch URL: a branch deploy uses the **production database**, so if a response comes back and fewer than 20 codes were unassigned it will top up — the same thing the daily job would do, but note it before you click. Prefer checking production after release if you want no side effect at all (the count is read-only when 20 or more remain).

| What you see | Meaning | Action |
|---|---|---|
| 404 / "not found" / method or scheduled-only error | Not reachable as a URL | Nothing to do |
| JSON with `generated` and `remaining` | Publicly reachable | Apply the minimal correction below |

## Safest minimal correction (only if reachable)
1. **Stop returning the counts.** Change both success responses to a generic `{ "ok": true }` and keep the counts in the existing `console.log` lines (the Netlify function log already has them). This is a two-line change, keeps the behavior and the schedule exactly as they are, and removes the information leak. Nobody consumes the response body (a scheduled run discards it).
2. Keep the top-up behavior unchanged: it is bounded and idempotent, and it is what the daily job needs.
3. Do **not** add a secret-header or "must be a scheduled event" check blind. A scheduled invocation cannot send custom headers, and the event shape Netlify passes to a scheduled function has not been confirmed from here; a wrong guard could stop the daily top-up and let the pool run dry, which is a worse failure (Etsy buyers would get no code). If you want a guard later, verify the scheduled event shape on a real production run first and add a test that the daily job still tops up.
4. Test: unit-test the handler with a mocked client (below / above threshold) asserting the body is `{ ok: true }` and the log still has the counts. No database needed.

Rollback: revert the commit; behavior returns to the current one.

## Related: `consume-generation`
Deprecated read-only shim kept so tabs opened before the reservation model do not break. It performs no charge. Remove it once no old tab can exist (a few days after release); not a risk now.
