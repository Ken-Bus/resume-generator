# Licensing boundary

## What is enforced, and where

| Action | Enforced by | Uses a generation? |
|---|---|---|
| Analyze Resume (`parse-resume`) | Server: reserve -> AI -> validate -> commit; failures release | **Yes, 1** (unchanged) |
| **Polish My Resume with AI** (`polish-resume`) | Server, same model as Analyze | **Yes, 1** (per successful polish) |
| Tailor to This Job (`tailor-resume`) | Server: signed token from a paid Analyze/Polish, max 5 runs per paid generation | No (unchanged) |
| **PDF / Word download** (`export-resume`) | **Server: the code is looked up in the database on every request, and the file is rendered on the server** | **No** (authorization check only) |
| Verify code (`verify-license`) | Server, read-only | No |
| Guided builder, Edit Fields, preview, templates | Browser: builder needs a verified code; nothing paid is called | No |
| Free sample | Open, watermarked, not printable, cannot be downloaded | No |

## The previous bypass, and how it is closed

**Before:** the editor and both exports ran entirely in the browser, so anyone could load the free sample, overwrite every field and download a finished resume without a code.

**Now:** the browser no longer contains any PDF/Word code. The files exist only as the response of `export-resume`, which refuses unless the license code is found in the `licenses` table. Changing the page (forging `state.license`, adding the `licensed` class, calling the function directly, editing the sample) gets a 401/403 and no file. This is tested at the function level (direct requests, no browser) and in the browser.

**Security model of `export-resume`**
- **Authorization:** code format check, then a database lookup on every request. There is no download token to steal or replay, and a deleted or revoked code stops working immediately.
- **Replay/expiry:** nothing to replay. The call has no side effects and consumes nothing.
- **Valid but exhausted code:** can still download. The code is the purchase; only the AI is limited by the five generations.
- **Brute force and scraping:** bad codes are limited per client (20 per 10 minutes) and good codes per code (60 per 10 minutes). **These limiters are in memory on each warm function instance**, so they slow a client but are not a global guarantee. A global limit needs a platform rate-limit rule or a small database table (a migration, so not done here).
- **CORS:** same-origin only. No `Access-Control-*` header is ever sent (tested).
- **Errors and logs:** generic messages; codes and resume text are never logged (only a non-sensitive error code), tested including database-error paths.
- **Privacy:** resume text now travels to the function to be rendered. It is not stored or logged.

## What cannot be prevented (honest limits)

- A person can always **screenshot or copy text from their own screen**. For unlicensed visitors the preview is watermarked and the print stylesheet hides it, which discourages casual use, but this is a deterrent, not a lock. What is protected is the product's download service.
- **Source and internals are no longer downloadable.** `netlify.toml` still publishes the repository root (`publish = "."`), but every path except the customer page (`index.html`, `wizard.js`, `resume-core.js`, `templates.js`, `404.html`) is answered with a forced 404: function source and prompts, SQL, scripts, tests, docs, setup notes and package files. `tests/functions/publication.test.js` fails if a tracked file is neither on that list nor blocked. This is configuration applied at deploy time, so confirm it on the branch deploy (see `docs/RELEASE_HARDENING.md`). Nothing secret was ever in those files (the design does not rely on secrecy of the renderer); this removes needless exposure of internals.
- `verify-license` now limits unknown or malformed codes per client (30 per 10 minutes, in memory on each warm instance, so best effort). Codes are 8 random characters (about 2.8 trillion possibilities), so guessing is impractical either way; a platform rate-limit rule is still recommended.

## Not changed
Pricing, the five included generations, entitlements, Supabase schema/permissions/migrations, token secrets, Netlify environment variables and deploy configuration. `license.js`, `token.js`, `config.js`, `supabase.js`, `verify-license.js`, `consume-generation.js` and `supabase/` have zero diff against `main`.
