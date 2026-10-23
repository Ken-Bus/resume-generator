# Proposal for owner approval: charge for the collective value of accepted changes

**Status: PROPOSAL ONLY. Not implemented.** `polish-resume` still charges by the current rule (`assessChange().reworded > 0`). The proposal is written as executable code and examples: `tests/functions/collective-rule-spec.js` and `tests/functions/collective-rule.test.js` (run with the normal suite; they change no behaviour).

## 1. Does today's rule support your principle? No, in one specific way.
Today: a polish is charged if at least one accepted line was REWRITTEN. Single-word edits ("minor") never add up. So a resume with six misspelled words and nothing else, polished perfectly, is judged "tiny touch-ups": **free, and none of the fixes is applied** (test: `quality-handler.test.js`, "CURRENT rule, documented"). The customer gets nothing and we pay for the call. Likewise three repeated lines merged into one, or three vague words made specific, never count. Everything else already works: one real rewrite charges, capitals/one typo/one synonym are free, unchanged is free.

## 2. The proposed rule (deterministic, no AI judgement)
Give every accepted change points by its kind, add them up, and charge when the total is **3 or more**: one real rewrite, or three corrections.

| Accepted change | Points | Example |
|---|---|---|
| rewrite (brings a content word the old line lacked) | 3 | "worked on the register and helped customers" -> "Operated the register and helped customers" |
| new line with a new content word | 3 | |
| rearranged (same words, new shape), a split-off line, a correction | 1 each | "Counted the drawer at closing" -> "At closing, counted the drawer"; one piece of a split run-on |
| correction = ONE word changed to its corrected form | 1 | spelling ("clossing" -> "closing"), grammar or tense ("handle" -> "handled"), a repeated word removed |
| one vague word made specific ("did", "stuff", "things", "various" -> a real word) | 1 | "Did the register" -> "Operated the register" |
| a repeated line removed (its words are still in the result) | 1 | "Made bread" + "made the bread" -> one line |
| capitals / punctuation / spacing, re-ordering a list | 0 | adding full stops to 12 lines |
| a synonym swap ("Helped" -> "Assisted"), one added word ("donated"), filler | 0 | five of these together are still 0 |

Charged when points >= 3. Points are measured against the customer's own words, so the AI cannot manufacture them.

## 3. What changes for customers (from the executable table)
| Result | Today | Proposed |
|---|---|---|
| 1 or 2 typos fixed | free | free (1-2 points) |
| 3 typos / 6 typos fixed | free, not applied | **charged, applied** |
| 3 vague words made specific | free | **charged** |
| 3 repeated lines removed | free | **charged** |
| one real rewrite | charged | charged |
| 5 synonym swaps, 5 added words, full stops on every line, a list re-ordered, nothing changed | free | free |
| a clear line split in two (padding) | charged | **free** (2 points) |
| run-on split into 3 clean bullets | charged | charged |
On the eight writing-quality personas only one changes (the six-misspellings resume: free -> charged and applied).

## 4. What does NOT change
Atomic reserve -> AI -> guard -> commit-or-release; every failure free; the factual guard (an unsupported line is withheld BEFORE points are counted, so withheld text never earns points); the free-attempt cap (3 per 15 min, 10 per day per code) for results that still come out free; one charge per accepted polish; price; five generations; Tailor. Implementation is one function swap in the handler (`changes.reworded === 0` -> `points(...) < 3`) plus the reply's `changes` object gaining `points`.

## 5. Edge cases and tradeoffs
- The threshold (3) is the one number in the rule. It is stated to the customer in one sentence ("a generation is used when the AI rewrites some of your wording or corrects three or more mistakes"). 2 is too eager (a typo and a comma); 4+ leaves "six small fixes" bordering free.
- A useful single fix (one typo) stays free. Accepted, and consistent with your decision that one corrected typo should not consume a generation.
- The AI could split text to earn points: a split piece is worth 1, so a trivial split is 2 points and free (tested). Repeat removal needs real repeats in the customer's input.
- Spelling/grammar counted by diff means a resume the customer already corrected costs nothing.
- Cost: results that are 3+ small corrections now cost a generation the customer previously did not pay, but they also now get the corrections applied (today they get nothing).
- Rollback is a one-line revert; no database change.

## 6. What I ask you to decide
Approve (a) the rule in section 2 with threshold 3, (b) the customer sentence above for the confirmation text and the Etsy FAQ. I recommend approving after the paid acceptance run, because that run shows whether real model output is mostly rewrites (rule irrelevant) or mostly small fixes (rule matters).
