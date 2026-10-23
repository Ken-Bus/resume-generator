# AI Polish writing-quality pass (2026-10-23)

Product purpose (owner decision): turn the customer's own information into a clear, organised, professional resume, especially for first-timers, long-tenured workers who struggle to describe their experience, people with spelling and grammar difficulties, career changers and people returning to work. Factual safeguards stay, but must not stop that job.

## 1. What limited the writing (audit)
| Limit | Evidence | Fix |
|---|---|---|
| **One flagged line threw away the whole entry.** When the AI split a run-on into bullets, the guard could not say which original line a flagged line replaced, so it put the WHOLE list back | 15-year warehouse persona: six improved bullets, one word ("drove") flagged -> 0 improvements | The flagged line alone is swapped for the customer's own line it came from; everything else is kept |
| Guard rejected wording the prompt itself recommends | "stuff" -> "products", "correct" -> "accurate", "drove" (past of "drive"), "shelves" for "stock" were all withheld as "new details" | Irregular verbs recognised; neutral nouns (products, items, tasks...), safe synonyms and obvious implications allowed; spelling corrections of the customer's own words ("closing" for "clossing") allowed |
| Prompt told the AI to leave single-word issues alone | Rule 11 (added in the previous pass) said not to fix small things | Replaced by a full brief: spelling and grammar everywhere, tense, run-ons and fragments, repetition, vague words, order, plain language; examples for each; clear lines left alone |
| Prompt numbering collided (two rules 5..10) and the key rules were buried | prompt text | One numbered list 1-18 |
| The AI could delete something the customer did | review | A dropped line whose words are not found in the entry's new lines is put back ("Preserve actual responsibilities") |
| Small fixes were discarded | six misspellings fixed = "tiny touch-ups", free, nothing applied | **Not changed** (charging policy): see `PROPOSAL_COLLECTIVE_CHARGING.md` |
| Frequencies slipped past ("daily", "every day") | They are plain words, so the new-word test ignored them | A frequency the entry never stated is withheld |
| The result card said only "AI reworded" | UI | "What changed: rewrote N lines; fixed spelling or a word in N lines; tidied capitals/punctuation in N; combined or removed N that repeated another" |

## 2. Desired experience, and where it stands
All nine points are covered by prompt + guard + tests, except that point 1 (spelling/grammar throughout) is only applied to the resume when the polish as a whole is charged under today's rule, which is the proposal.

## 3. Fair charging
Evaluated: today's rule (a rewrite charges; one-word edits never add up) does NOT support "many small corrections can collectively be worth a generation". Proposal (not implemented): points per accepted change, charge at 3 or more. See `docs/PROPOSAL_COLLECTIVE_CHARGING.md` with its executable table (`tests/functions/collective-rule.test.js`).

## 4. Challenge results
Nine fictional resumes (`tests/functions/quality-corpus.js`): first-timer with many misspellings, 15-year warehouse worker with run-ons and mixed tense, retail with weak openers and repetition, career changer, returning after a gap, disorganised and repetitive, incomplete shorthand, six-misspellings-only, already-clear. For each the "ideal" edit is accepted whole (0 withheld), mistakes are gone from the accepted resume, facts are untouched, bullets read as bullets, and PDF and Word (12 templates each) carry the corrected wording. With an invention slipped into the good edit, exactly that line is removed and the rest stays. A resume that is already clear is left alone.

## 5. Files
`netlify/functions/polish-resume.js` (prompt), `netlify/functions/_lib/integrity.js` (guard, line-level withhold, preserve duties, change items), `wizard.js` (summary line), `resume-core.js` (guard version `entry-scope-withhold-5`), tests `quality-corpus.js`, `quality-pipeline.test.js`, `quality-handler.test.js`, `collective-rule*.js`, UI cases in `ui/stress-system.test.js`.

## 6. What cannot be verified here
How the live Sonnet 5.5 behaves with the new brief. The mock tests prove what happens to any answer; they cannot prove the model will write the ideal answer. The single paid acceptance run is still the gate.
