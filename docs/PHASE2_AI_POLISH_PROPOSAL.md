# Phase 2 proposal: "Polish my answers" (paid AI step) — NOT implemented, NOT active

**Goal:** turn a beginner's plain answers from the guided builder into professionally worded bullets and a summary, without inventing anything.

**Charging (reuses the existing credit system unchanged):** one new endpoint, `draft-resume`, structured exactly like `parse-resume`:
1. All validation (code format, input size, shape) runs before any AI call.
2. `reserve_license_use` → AI call → validate → `commit_license_use`; any failure → `release_license_use` (no charge; provider outages never count against the failure budget).
3. One successful polish = **one** generation, and it mints the same signed `tailorToken` as Analyze, so the free, capped Tailor behavior is identical afterward.
No SQL migration is needed: reservations are not tied to a function name.

**Inputs/outputs:** the builder's structured answers in; the same resume JSON out (so the editor, preview and exports need no change).

**Fabrication controls (already built and tested for Tailor, in `netlify/functions/_lib/integrity.js`):**
- Facts (name, contact, employers, titles, dates, schools, certifications, awards) restored from the customer's answers.
- Lines containing numbers, leadership wording or credential wording not present in the answers are flagged in yellow with "Added by AI: make sure this is true"; one-click Undo restores the pre-polish resume.
- Prompt forbids new numbers, certifications, duties and supervisory claims.

**Safety switch:** ship disabled behind an environment flag (e.g. `DRAFT_RESUME_ENABLED`), default off, so nothing chargeable goes live without the owner's approval.

**Tests required before enabling:** the existing accounting suite pattern (success charges once, every failure mode is free, concurrent requests cannot overspend, throttling), plus fabrication cases and a UI test that the button never fires without a code.

**Owner decisions needed:** go/no-go; whether polish costs 1 generation (recommended, same as Analyze); button wording; whether polish can be re-run (each run = 1 generation).
