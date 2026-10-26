# Beginner AI Polish (owner decision 2026-10-26)

Goal: help first-time job seekers say what is already true about them more clearly, without inventing or inflating anything, and without charging for superficial changes. Charging is otherwise unchanged: the 3-point threshold (`_lib/scoring.js`), one generation per accepted meaningful result, nothing for unchanged / cosmetic / withheld / failed results, duplicate-charge protection and the 24-hour recovery copy.

## What changed
| Where | Change |
|---|---|
| `polish-resume.js` prompt, rule 18 | Replaces the blanket "restate only" headline rule. "Good at X" may become "X skills". A skill the person HAS, something they WANT TO LEARN and work they DID are kept apart. No traits, no unstated goals ("opportunities to develop"), no numbers, no new skills, no new line that only repeats skills or facts shown elsewhere. |
| `polish-resume.js` prompt, rule 19 | Only when the customer **explicitly chose the first-resume path AND listed no work history** (`isEntryLevel`): the plain word "entry-level" may precede the position they asked for, and the strengths THEY listed may be added to that one headline sentence. Everyone else is told not to describe their level. |
| `integrity.levelClaims` (called by `guardResume`) | A line that GAINS "entry-level", "beginner", "first-time" or "no experience" is put back unless the customer wrote the phrase or `options.entryLevel === true`. Reported like any withheld line (reason: "a level of experience you did not state"). |
| `integrity.pruneRestatedAdditions` (called by `polish-resume.js` after the guard) | A NEW list line (bullet or skill) that only repeats words the resume already has is dropped and never applied. |
| `scoring.js` | The same kind of line scores **0** (`by.restated`) instead of 3 (or 1 as a "split"). |

## The restatement rule (smallest defensible form)
A line counts as a restatement only if it is a brand-new line (it shares no words with an old line of its group) AND either
* every content word of it is already somewhere in the customer's resume, or
* it looks like a split of old lines, but none of the old lines of that group was modified or dropped (so it is just a copy of lines left as written).

Everything else keeps its approved value: a real rewrite of an existing line (new wording the old line lacked) is still 3, genuine splits (the old line replaced by its pieces) are still 1 per piece, spelling / tense / vague-word fixes are still 1 each.

## Edge cases (all pinned in `tests/functions/beginner-polish.test.js`)
1. **A blank headline filled in from the customer's own skills** ("Applicant with teamwork skills") used to score 3 and charge. It is now a restatement: applied, free. One existing test (`polish.test.js`) was updated to this decision.
2. **Words that come from the target job but are not in the resume** are not "already in the resume", so such a line can still score 3 if the guard accepts it.
3. **"Entry-level" alone is 1 point (free). "Entry-level" plus the customer's listed strengths in the headline is a real rewrite (3 points, one generation).** This is the approved threshold working as designed; a separate review would be needed to treat it differently.
4. **A skill promoted from a bullet into the skills list** is a restatement and is dropped. The prompt already forbids adding skills.
5. **A "first resume" applicant who also listed work history** is not entry-level: the wording is not offered and any "entry-level" the AI adds is put back.
6. **The replay cache and input hash include the entry-level mode**, so a retry after changing the profile choice is a new operation, never a stale replay.
7. **Pruned lines are not listed as "left out"**; if pruning leaves nothing to apply, the customer sees the normal "nothing meaningful to improve" message and nothing is charged.
8. Words the customer wrote themselves ("Beginner", "entry level") are theirs and are never put back.

## Not verified
The prompt wording has only been exercised with a mocked AI. How the live model responds to it is unverified until one authorized personal-code run on a deployed build.
