# Licensing boundary review (guided builder release)

**What is enforced, and where**

| Action | Enforced by | Uses a generation? |
|---|---|---|
| Analyze Resume (`parse-resume`) | Server: reserve → AI → validate → commit; failures release | **Yes, 1** (unchanged) |
| Tailor to This Job (`tailor-resume`) | Server: signed token from a paid Analyze, max 5 runs per paid generation (database-enforced) | No (unchanged) |
| Verify code (`verify-license`) | Server, read-only | No |
| Guided builder (new) | Browser: needs a verified code (`WIZARD_REQUIRES_LICENSE` in `wizard.js`) | **No.** Manual entry never calls a paid endpoint |
| Free sample, Edit Fields, templates, PDF/Word export | Nothing (all run in the browser) | No |

**Finding: the sample/editor/export workflow is not a credit bypass, but it is a free-use path.**
Everything that costs money (the AI calls) stays enforced on the server and was not changed. But the editor and both exports run entirely in the browser, so anyone who loads the free sample can overwrite every field and export a finished resume without a code. This has been true since launch. The guided builder is gated behind a verified code, so this release does not add a new free path, but the repaired PDF export makes the existing one more usable.

Browser-side gating cannot be made secure (the page and its scripts are public). Options, owner's decision, none applied:

1. **Accept** it: the paid value is the AI (Analyze + Tailor). Simplest.
2. **Deterrent**: unlicensed exports carry a small "Made with Flex & Grace" footer line.
3. **Require a verified code to export** (deterrent only; a determined user can bypass it).

**Not changed in this release:** pricing, included credits (5 per code), entitlements, Supabase schema/permissions, token secrets, deploy configuration.
**To make the builder open to everyone** (a customer-access change): set `WIZARD_REQUIRES_LICENSE = false` in `wizard.js`.
