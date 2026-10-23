# What is worth a generation? (decision record)

> **SUPERSEDED 2026-10-23.** The owner's Product Trust & QA Directive approved the collective-improvement rule (a rewrite is 3 points; a genuine spelling/grammar/tense correction, removed repetition or vague word made specific is 1 point; cosmetic and synonym changes are 0; 3 points or more charges exactly one generation, fewer keeps the customer's wording and charges nothing). It is implemented in `netlify/functions/_lib/scoring.js` and described in `SETUP.md` and `docs/PROPOSAL_COLLECTIVE_CHARGING.md`. The text below is the earlier rule, kept as the record of how the decision developed. The "insertion-only edits are never chargeable" proposal below was not adopted.

**Trigger:** a live test charged one generation when the only accepted change was "Helped organize food for pickup." -> "Helped organize **donated** food for pickup." The owner ruled that too minor to charge.

## Implemented now (ordinary code; no change to price, the five-generation entitlement or Tailor)
A polish is charged only if an accepted line was **rewritten**. Judged by the shape of each edit (`classifyEdit`), deterministically, with no line-length or word-count cut-off:

| Kind | Definition | Charged? |
|---|---|---|
| cosmetic | only capitals, punctuation, spacing, or the same lines in a different order | no |
| minor | ONE word added, removed or swapped in ONE place, or only filler words changed | no (however many) |
| rewrite | two or more separate edits, a restructured sentence, several words replaced, a new line | **yes** |
| dropped | a line removed | no |

The customer-facing sentence: *"A generation is used only when the AI rewrites some of your wording. Changing one word, capitals or punctuation doesn't count."*

Also done: the AI is told not to make single-word swaps (prompt rule 11), and lines are now matched by content, not position (deleting a duplicate or re-ordering used to look like several rewrites and was charged).

## Why no classifier can be perfect (be explicit)
Value is subjective. This rule can only judge the SHAPE of an edit:
- It under-charges a genuinely useful one-word fix ("handle" -> "handled", or "recieve" -> "receive" when it is the only change). Accepted: the customer is never surprised by a charge, and the cost is a small AI call we absorb (capped by the free-attempt limit: 3 per 15 min, 10 per day per code).
- It charges a two-word edit that adds little ("responsible for ..."). Prompt rule 11 and the factual guard make this unlikely; it cannot be excluded deterministically.
- A weak-opener upgrade of two words ("Worked on the register" -> "Operated the register") is a rewrite (charged); a one-for-one swap ("Helped" -> "Assisted") is not.

## One open proposal (needs the owner; not implemented)
**Proposal: "insertion-only edits are never charged"** — treat any edit that only ADDS words (no original word removed, replaced or moved) as minor, however many words it adds.
- For: closes the loophole where a two-word filler insertion is charged; matches the owner's instinct that adding words to a sentence is not rewriting it.
- Against: a legitimate improvement that is only an addition ("Answered phones" -> "Answered customer phones daily", using details from the same entry) becomes free, so the AI would be less incentivised (and the product less valuable) for sparse resumes, which are exactly the ones that benefit most from added detail.
- Recommendation: **do not adopt now.** Run the paid acceptance test first and read the `ai-outcome` lines (`reworded`, `minor`, `withheld`). If real answers show charged results whose only change is an insertion of little value, adopt it then (a one-line change in `classifyEdit` plus its table test).

## Unchanged business rules
$11 price, five generations, Tailor allowance, no charge for unchanged/cosmetic/flagged-only, one charge per accepted rewrite, failures free.
