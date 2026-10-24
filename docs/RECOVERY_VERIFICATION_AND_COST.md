# Recovery verification matrix and cost / capacity update

Feature branch `feature/guided-resume-and-export-fixes`. Fictional customers, local PostgreSQL 16, mocked AI and Chromium automation. **Nothing here is live Anthropic, live Supabase or live Netlify behaviour.** See also `docs/MIGRATION_04_RECOVERY_PACKAGE.md`.

## 1. Interruption outcomes (what each test proves)

Columns: **Doing** = what the customer was doing · **Failed** · **Kept** · **Sees on return** · **Gen used?** · **Safe to continue?** · **Disclosed/overwritten?** · **Extra cost?**. "Extra cost" is "none" wherever no AI call and no new service is involved. Test = file › name fragment.

| # | Doing | Failed | Kept | Sees on return | Gen used? | Safe? | Disclosed / overwritten? | Extra cost | Test |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Typing in Guided Builder | Power cut before the 0.5 s save fired | Last saved version (a consistent earlier state, never a half-written one); last few keystrokes may be lost (stated honestly) | "Continue where I left off" / "Start fresh"; nothing applied silently | No | Yes | No, local to the device only; credentials never in the draft | None | `ui/interruptions` › GUIDED BUILDER; `ui/drafts` › FLUSH, RESTART |
| 2 | Typing, then refresh or tab discarded | Page reloaded | Everything (save on pause + on page hide) | Same tab: restored with no prompt. New session: Continue offer | No | Yes | No | None | `ui/drafts` › FLUSH, A refresh of the SAME tab |
| 3 | Moving between Guided steps, switching Guided / Edit Fields, rapid edits | Interruption mid-navigation | Step, answers, edits made in either view | Back on the same step with all answers | No | Yes | No | None | `ui/interruptions` › GUIDED BUILDER; `ui/guided`, `ui/work-safety` |
| 4 | Two windows / older snapshot | A stale window tries to save | Newer work; the stale window stops saving | Page says so; customer chooses | No | Yes | Never overwritten by an older snapshot | None | `ui/drafts` › TWO WINDOWS, NEVER OVERWRITES |
| 5 | Using a browser with storage blocked or full | Cannot save | Work stays on screen; fallbacks tab-only | Honest "not saved on this device, download your resume" (never a false "Saved") | No | Yes | No | None | `ui/drafts` › STORAGE FAILURES |
| 6 | Shared computer | Next person opens the site | Draft only on that device, deleted after 14 days; "Clear this saved copy" removes draft, code and tab keys | After clearing: nothing left (no resume text, no code, no token) | No | Yes | **Limitation:** until cleared or 14 days pass, the next person on the same browser profile can see the draft. Stated in the banner and FAQ | None | `ui/drafts` › OLD DRAFTS EXPIRE, Clear; `ui/interruptions` › SHARED COMPUTER |
| 7 | Paid Polish / Analyze just finished | Power or network lost; reply never seen | Charge **and** encrypted copy (one transaction) | After entering the same access code: "A finished result is saved for you" → Restore | **No new one** (the original was charged once) | Yes | Only the code holder can open it; generic 404 for everything else | None (no AI call) | `functions/result-recovery` › RESTORE, CHARGE + COPY; `db/result-recovery` › ATOMIC |
| 8 | Retry after a lost reply (same request id), cold server | Instance memory gone | Exact stored result | Same result byte for byte, "exactly as it was" | No | Yes | No | None | `functions/result-recovery` › SAME REQUEST ID; `durable-idempotency` |
| 9 | Returning on another device or after a browser restart with nothing stored | Session storage empty | Server copy | Restore offer after entering the code (only the code is needed) | No | Yes | Code is the sole credential | None | `ui/restore-result` › MAIN SCENARIO; `functions` › RESTORE |
| 10 | Asking again and again | Repeated requests across servers | Copy (reading does not delete it) | Same result every time; a second lost reply is also recoverable | No | Yes | Rate-limited (30 lookups / min, 30 misses / 10 min per client) | None | `functions/result-recovery` › REPEATED RECOVERY, HAMMERING, GUESSING |
| 11 | Returning after 24 h | Copy expired | Nothing (by design) | "We couldn't find a saved result"; the charge record stays | No | Yes | Expired rows are never returned even if cleanup is late (checked in SQL on every read) | None | `db/result-recovery` › EXPIRY; `functions` › EXPIRY |
| 12 | Paying while the database fails | Storing the copy fails | Neither the charge nor the copy | "Try again", nothing charged, retry works | **No** | Yes | No | None | `db/result-recovery` › ATOMIC; `functions` › FAULT: charge-with-copy |
| 13 | Restoring while the database fails | Read fails | Copy untouched | Plain "try again", no content, nothing charged; next attempt restores | No | Yes | No content or secrets in the error or the logs | None | `functions/result-recovery` › FAULT DURING RETRIEVAL |
| 14 | Someone else tries to restore | Wrong code, guessed id, another customer's id | n/a | Identical generic "not found" for every case | No | n/a | None (verified identical status, body and no id echo) | None | `functions` › AUTHORIZATION; `db` › SCOPE |
| 15 | Server secret missing or short, or migration 04 missing / rolled back | Misconfiguration | Balances | "Try again" (503) **before any AI call**; nothing charged or reserved | No | Yes | No | **None**: no Anthropic spend either | `functions` › REQUIRED SECRET; `compat-matrix` (B, C, D, R3, R4) |
| 16 | Application rollback or half-finished deployment | Old and new app overlap | Balances and every paid step | Old app keeps charging correctly; new app refuses while 04 is absent; after roll-forward the lost copy is honestly regenerated | Only as before | Yes | No | None | `functions/compat-matrix` |
| 17 | After a restore | Wants PDF / Word, Tailor, original wording | All | PDF and Word download (licence checked); Tailor authorisation is for the same generation; "Restore all my original wording" works | No | Yes | No | None | `functions` › INTEGRATION; `ui/interruptions` › INTEGRATION; `ui/restore-result` |
| 18 | Open reservations never finished (abandoned) | Browser vanished mid-AI call | Reservation lease | Expires by lease; balance never double-charged; no copy because nothing was committed | No | Yes | No | None | `db/reservations`, `db/migration03-review` |

**Deliberate difference from the feasibility proposal:** the proposal deleted the copy "on receipt". Implemented design never deletes because a response was sent (a lost second reply must also be recoverable); the copy simply expires within 24 h and an hourly job deletes it. The page records a short, non-secret reference of results it already received so it does not offer them again. No test fakes a verified-receipt deletion.

## 2. Billing and idempotency

Verified in real SQL: one charge per request; copy and charge atomic; refused / released / exhausted commits store nothing; the same request id never charges twice (cold instance included); a restore consumes nothing and adds no Tailor runs; below-3-point and no-change results stay free and store nothing; five purchased generations and Tailor 5-per-generation unchanged. Anthropic's $20 monthly limit untouched (no limit change, no call made).

## 3. Cost and capacity update

**Stays inside existing resources; no new service, subscription, storage product or plan change is required by the code.**

| Item | Estimate | Basis |
|---|---|---|
| Stored size per result | about 0.4 KB to 10 KB (measured 2.2 KB of JSON sealed to a 408-byte record after compression; real resumes larger) | `vault.js`, gzip then AES-256-GCM |
| Rows alive at once | at most (generations per day), each lives under 24 h; the $20 Anthropic limit caps this at roughly 450 completed generations per month, so about 15 per day, under 0.2 MB at any time | feasibility §5.5 |
| Database | far below any plan's database limit (Free: 500 MB reported) | arithmetic |
| Extra function calls | 24 purge runs a day + one list and (when used) one fetch per unlock; negligible compute credit (well under 1 credit a month on the credit model reported for Netlify) | feasibility §1 |
| Encryption | Node built-in `crypto`, no paid service | code |
| Anthropic | No new calls. Recovery avoids regeneration, so spend can only go down | tests assert zero AI calls |
| **Incremental monthly cost** | **$0**; at most a few cents of Netlify credits if the account is already pay-as-you-go | |

Differences from the feasibility proposal: delete-on-receipt dropped (expiry only), at most 3 newest copies per code listed, hourly scheduled purge instead of "purge on receipt", purge also runs lazily on list and in `check-code-supply`. None increases cost.

### Owner must verify before authorising production (I could not see your accounts)
1. **Supabase plan.** If it is Free: projects can **pause after about a week of inactivity**, and a paused project cannot restore anything (reported behaviour; confirm). Confirm database size headroom and whether backups exist on your plan (this changes the privacy sentence about backups: with no backups, nothing persists after the purge).
2. **Netlify plan.** Confirm scheduled functions are included, remaining credits, whether auto-recharge or overage is **off**, and the synchronous function time limit (the repo assumes 60 s).
3. **Netlify environment:** where to set `RESULT_ENCRYPTION_KEY` (Functions scope, all production contexts) and that it differs from `TAILOR_TOKEN_SECRET`.
4. **Anthropic:** leave the $20 limit alone; confirm no auto-recharge.
5. Do not enable any paid Supabase or Netlify add-on for this feature; none is required.

## 4. Not verified (requires production or real devices)
Netlify scheduled execution, real Supabase/PostgREST permissions and schema cache, production key presence, real phones' storage eviction behaviour, true power-loss flush behaviour of localStorage on real hardware, backup retention, live Anthropic output.
