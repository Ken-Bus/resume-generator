# AI model and usage log

**Status:** implemented on `feature/guided-resume-and-export-fixes`; **not merged or deployed**. Tested only with a mocked AI provider (no paid call has been made).

## Model
- All three paid features (Analyze, AI Polish, Tailor) use **`claude-sonnet-5-5`** (`netlify/functions/_lib/config.js`). The previous model, `claude-sonnet-4-5-20250929`, is deprecated and **retires November 30, 2026**; after that date every request to it fails.
- **No up-front thinking.** Sonnet 5.5 thinks before answering unless told otherwise, and thinking tokens are billed as output and count toward `max_tokens`. These are plain rewrite/extract jobs with no tools, so requests send `thinking: { type: "between_tools" }` (Anthropic's documented lowest setting; the reply is text only). `"disabled"` is rejected by this model with a 400, so it must not be used.
- **Replies are read by block type** (never `content[0]`), because a response can begin with a thinking block. Several text blocks are joined. A sentence around the JSON is tolerated; non-JSON is still a failure.
- **New stop reasons:** `refusal` and `model_context_window_exceeded` are failures like truncation: the reservation is released, nothing is charged, and they count toward the existing per-code failure budget (they may have cost tokens). A retired/unknown model or any HTTP error is a provider fault: released, uncharged, uncounted.
- **Token caps raised by about 30%** (Analyze 4,000 -> 5,200; Polish and Tailor 6,000 -> 8,000) because the new tokenizer produces about 30% more tokens for the same text; without this, long resumes that worked before would start to truncate. Worst-case spend per call is about the same as before.
- Not sent (and not needed): `temperature`, `top_p`, `top_k` (removed in API version 2026-10-21), prefill, tools, beta headers. `effort` is left at its default (`high`); it is a later cost lever once real usage is known.
- Unchanged: price, five generations, Tailor allowance (5 per paid generation, 2 failed runs forgiven), reservation/commit/release, the failure throttle, the no-change cap, integrity safeguards, exports.

## Usage log (privacy-safe)
Every provider call writes one line to the Netlify function log:

```
ai-usage {"fn":"polish","model":"claude-sonnet-5-5","in":1704,"out":713,"stop":"end_turn","usd":0.0105,"ms":9120,"ref":"<reservation uuid>"}
```

| Field | Meaning |
|---|---|
| `fn` | `analyze`, `polish` or `tailor` |
| `in` / `out` | Input / output tokens reported by Anthropic (`null` on a timeout) |
| `stop` | `end_turn`, `max_tokens`, `refusal`, `timeout`, ... |
| `usd` | **Estimated** cost from `PRICE_PER_MTOK` in `config.js` (Anthropic's per-million-token prices). Estimate only; never used for charging. |
| `ms` | Call duration |
| `ref` | The random reservation id. The same id appears in the `released / not charged (P201)` and `generation failed` lines, so you can tell whether a call was charged, released as no-change, or failed. Tailor lines carry the id of the paid generation that authorised them. |

**Never logged:** resume text, job descriptions, prompts, replies, names, emails, license codes, API keys. Every field is a number, a short word or a UUID; anything else is dropped (`_lib/usage.js`, covered by tests).

Failed and unusable calls are logged too (their tokens are billed). To measure real cost: Netlify -> Logs & metrics -> Functions -> search `ai-usage`, then total `usd` by `fn`, and compare against the Anthropic Console usage page. When `MODEL` changes, update `PRICE_PER_MTOK` with it.

## Estimated cost (fictional-resume sizing, **estimates**, not measured)
Sonnet 5.5 is $2 / $10 per million tokens but counts about 30% more tokens, so the saving over Sonnet 4.5 ($3 / $15) is about **13%**, not a third.

| Resume | Analyze | Polish | Tailor | 1 Analyze + 4 Polish + 25 Tailor |
|---|---|---|---|---|
| Light (first resume) | $0.003 | $0.005 | $0.006 | $0.17 |
| **Typical (3 jobs)** | **$0.011** | **$0.014** | **$0.016** | **$0.45** (4.1% of $11) |
| Heavy | $0.036 | $0.039 | $0.044 | $1.30 |
| At the input limits | $0.073 | $0.126 | $0.130 | $3.83 |

A realistic customer (1 Analyze, 2 Polish, 6 Tailor) is about $0.13. Exposure: no-change Polish about $0.14/day/code at most; counted failures about $0.41/day/code at most (typical resume). Replace these with the measured numbers from the usage log.

## Owner acceptance (needs a paid call, so needs separate approval)
Use the personal test license and fictional data on the branch deploy; each Analyze or meaningful Polish spends one of its generations. Check the `ai-usage` lines in the Netlify log each time.
1. **Analyze** one fictional pasted resume: parses, counter -1, one `ai-usage` line with `fn":"analyze"`.
2. **Polish** (meaningful): wording improves, counter -1, flagged lines (if any) shown, `usd` close to the table above.
3. **Polish with nothing to improve** (already-clear answers): "No meaningful improvements were found", counter unchanged, P201 in the log.
4. **Tailor**: works with the token, counter unchanged, one `ai-usage` line with `fn":"tailor"`.
5. **A long fictional resume** (about 3-4 pages): confirm it finishes inside the 50-second limit and does not truncate. Longer outputs from the new tokenizer make this the most likely place for a surprise.
6. **Re-test the clean Taylor Rivera resume** after the prompt change (Oct 22). If the model still returns nothing meaningful, that costs nothing (P201). If it improves the wording, it costs one generation: read every changed line against the original and confirm no invented fact, number, title or praise word.

## Outcome line and measuring real cost (added in the release-hardening pass)
Besides `ai-usage`, every paid attempt writes one `ai-outcome` line, joined to it by the same reservation id:

```
ai-outcome {"fn":"polish","outcome":"flagged","reworded":0,"withheld":3,"ref":"<reservation uuid>"}
```
`outcome` is `charged`, `nochange` (nothing to improve), `flagged` (everything withheld), `failed` or `ok` (Tailor). Join the two lines on `ref` to total the AI cost of each kind of attempt, and to see how much is spent on attempts the customer is not charged for. Tokens per second for a call is `out / (ms / 1000)`: use it to calibrate the timeout and the long-resume limits after the first real runs.

**Limits derived from the output caps** (so a call that is certain to be cut off is refused for free): Analyze refuses pasted text over 20,000 characters; Polish and Tailor refuse a resume whose JSON is over about 19,000 characters (`_lib/limits.js`: the reply is about as long as the request, at roughly 0.385 output tokens per character against `TAILOR_MAX_TOKENS`). Timeouts and truncations show a plain "too long" message and are counted failures; nothing is charged. These limits are arithmetic, not measured: re-check them against the long-resume acceptance test.
