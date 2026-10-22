# Proposal: do not charge for an AI Polish that changes nothing

**Status:** APPROVED by the owner and IMPLEMENTED on `feature/guided-resume-and-export-fixes` (not merged, not deployed). See `docs/AI_POLISH.md`, "The no-charge rule", for the behaviour as built. The text below is the original proposal, kept as the record of the investigation. Where it differs, the approved decisions are: cosmetic-only edits are NOT meaningful (A1); no-change releases are NOT counted against the database failure limits, and are instead capped separately and in memory per instance (`_lib/nochange.js`); the confirmation wording and an Etsy FAQ draft (`docs/ETSY_FAQ_AI_POLISH.md`) were prepared.

## What happened
In the real-browser test (fictional first-time applicant "Taylor Rivera", branch `feature/guided-resume-and-export-fixes`, commit `38fdf04`), AI Polish returned success, used one generation (5 -> 4 at the time), and the resume showed no visible improvement.

Local analysis (no AI call, no credit, fictional data only) shows the server and the page both do their job:
- the integrity step only restores facts and flags added claims; a genuinely reworded line passes through untouched;
- the page replaces the resume with whatever the server returned (an existing click-through test proves the preview shows the new wording);
- an unchanged reply yields **zero** differences, is **not** treated as a failure, and is therefore committed (charged), because the only success test today is "valid JSON that looks like a resume".

So the charge was a valid outcome under today's rules, and the missing piece is a rule about *meaningful* change. The remaining unknown is why the AI returned the same wording; see "Owner-only verification" in the report.

## Recommended rule (Option A)
**Charge only if at least one line was reworded.** Release the reservation (no charge) when `assessChange(...).reworded === 0`.

- `assessChange` already exists and is tested (`netlify/functions/_lib/integrity.js`). It counts, per line: `reworded` (different words, or a line added/removed), `cosmetic` (only capitals, punctuation or spacing differ), `unchanged`.
- **Cosmetic-only edits (e.g. "packed boxes on saturdays" -> "Packed boxes on Saturdays") count as no change.** Alternative A2: any visible difference charges. A1 (recommended) is simpler to explain and never bills for something a customer could do in a second; A2 bills for capitalisation fixes the customer may genuinely want.
- Implementation, about ten lines in `polish-resume.js`, before the commit step:
  - if `changes.reworded === 0`: `license.safeRelease(supabase, reservationId, true)` and answer 200 with `{ result, charged: false, usesRemaining: <unchanged>, ... }`, no tailor token needed (nothing was spent);
  - the page shows "We didn't find anything to improve. Nothing was used." and does not touch the counter.
- **No SQL, no change to reserve/commit/release semantics, no migration.** It uses the existing `release_license_use` exactly as AI failures do.

## Decisions needed from the owner
1. **Threshold:** A1 (cosmetic-only is free, recommended) or A2 (any visible change is charged).
2. **Failure budget:** release as a *counted* failure (recommended) so these attempts share the existing throttle (6 per 15 minutes, 30 per day per code). Release as *uncounted* and a customer could re-run an already-clear resume without limit at the owner's API cost. At the existing 30/day cap the worst case is a few dollars of API spend per code per day, the same exposure already accepted for malformed-JSON failures.
3. **Wording:** the confirm box currently says "You are only charged if the polish completes." Proposed: "...if the polish completes and improves your wording."
4. **Listing/FAQ:** if the Etsy listing promises "5 generations" in a way that depends on this, a one-line FAQ note ("a polish that finds nothing to improve is not counted") is worth adding. Not touched here.

## What this branch already does (no accounting change)
- Reports `changes: { reworded, cosmetic, unchanged }` in the polish response and writes a content-free warning (`polish-resume: charged result had NO wording changes`, ref `P201`, reservation id and counts only) to the function log, so the next real test shows what the AI returned without exposing any resume text.
- The page no longer shows "✓ Polished" for an unchanged result. It says "No wording changes were made", and states honestly that one generation was used.
- A polish reply that blanks out an entry's description or bullets can no longer erase the customer's own text (polish only; Tailor is unchanged).
- `tests/functions/polish.test.js` has a **todo** test, "DESIRED: a polish whose result has no wording changes is released, not charged". It fails today by design and is reported on every run without failing the suite. On approval: delete `todo`, implement the ten lines above, and change the first Taylor test from "charged exactly once" to "released".

## Not part of this proposal
Making the AI produce more rewording on already-clear answers is a prompt-quality question (rules 5 and 10 tell it to leave clear lines and the headline alone). It should be judged on a real polish after the P201 log is deployed, not changed blind.
