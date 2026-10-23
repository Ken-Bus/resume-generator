# Etsy FAQ wording: generations, AI Polish, Tailor and your information (DRAFT, NOT PUBLISHED)

*Recommended text for the AI Resume Generator listing, revised 2026-10-23 for the owner-approved charging rule (3 points) and the work-saving change. The live Etsy listing has NOT been changed (nothing in this QA assignment touches Etsy). Publish only after the branch is merged and deployed, because until then the live app behaves differently. Review against the listing checklist first.*

## Recommended FAQ entries

**Q: What counts as one of my 5 generations?**

A: Your access code includes 5 AI generations. A generation is used when the AI successfully analyzes your pasted resume, or when AI Polish makes real improvements to your wording (see the next question). Typing, building your resume step by step, previewing, editing, switching templates, tailoring to a job and downloading never use one. Downloading a PDF or Word file never uses a generation, even after all 5 are used.

**Q: If the AI Polish doesn't improve my resume, do I lose a generation?**

A: No. When you choose "Polish My Resume with AI," the AI reviews your resume and corrects spelling, grammar and tense, tidies run-on lines and repeats, and says things more clearly, using only what you wrote. A generation is used when it rewrites some of your wording or corrects three or more mistakes. If it finds fewer than that (for example just one or two small fixes), it still applies those fixes and nothing is used. If it finds nothing to improve, or if everything it suggested added details you didn't give, nothing is changed and nothing is used. You can always undo a polish with "Restore my wording."

**Q: Will the AI add things I didn't say?**

A: It is designed not to. It may only reword what you wrote, in plain language that fits you. Your name, contact details, employers, job titles, dates, schools and certifications are always copied exactly from your answers. If the AI suggests something that adds a detail you didn't give (for example a number, who benefited, a result, a skill you didn't list, or a bigger role than you described), that suggestion is left out and your own wording is kept. You can always undo a polish with "Restore my wording," and you should still read your resume before you send it. No tool can promise it never makes a mistake.

**Q: Will it make me sound like someone I'm not?**

A: No. The AI is told to keep your level of involvement ("helped" stays "helped"), to use natural, modest words, and not to add praise such as "motivated" or "dedicated" unless you wrote it. Your resume should sound like you on a good day, not like a different person. Always read it over and change anything that doesn't sound like you.

**Q: What is "Tailor to This Job"?**

A: Paste a job description and the AI adjusts the emphasis and wording of your resume toward it, using only what is already in your resume. Each time you use a generation you also get up to 5 tailoring runs for that resume, and tailoring never uses a generation. It follows the same rules as AI Polish: suggestions that add details you didn't give are left out.

**Q: What if something goes wrong while the AI is working?**

A: If the AI can't finish, nothing is used. Your counter always shows how many generations you have left. If your screen refreshes or your phone loses signal while the AI is working, your resume is still there when the page comes back, and if you press the same button again for the same resume it recovers that result instead of using a second generation. This works for about an hour after the first try. If the AI service itself is very busy you will be told to wait a minute and try again; nothing is used. If a generation did go missing, please message us with your access code and we will look at it.

**Q: Is my resume kept if I refresh the page?**

A: Yes, within the same browser tab. A copy of your resume is kept in your own browser tab so a refresh does not lose your work. It is not sent anywhere, and it disappears when you close the tab. On a shared computer, use "Clear this saved copy" (shown when your work is restored) or simply close the tab.

**Q: Can I use a very long resume?**

A: AI steps work best on resumes of up to about 5 to 6 pages. Pasting more than about 20,000 characters is not accepted for analysis, and a resume too long for AI Polish or Tailor is refused with a message before anything is used. You can still edit and download any length yourself.

**Q: What if I don't give the AI much to work with?**

A: It will tell you. If there are only a few words to work with, it asks you to add a little more (what you did, and what you worked with) instead of making something up, and nothing is used.

**Q: Can I keep asking the AI to review the same resume?**

A: If the AI has reviewed your resume several times in a row and found nothing worth applying, the app will ask you to wait a few minutes before trying again (you can keep editing and downloading meanwhile). This protects your account and is never charged.

**Q: Are my resume and access code kept private?**

A: Your resume text is sent to the AI service to be processed and to our server to build your PDF or Word file. We do not store it or write it to our logs. (A copy stays in your own browser tab, as described above.)

## Short version (for the description's "HOW IT WORKS" section, one line)

"AI Polish uses one of your 5 generations only when it rewrites some of your wording or corrects 3 or more mistakes, and only in ways that stay true to what you wrote. Smaller fixes are applied free."

## Claims to avoid (not demonstrated, so not to be made)
- Do not say the resume is "ATS-friendly", "ATS-optimized" or "will get you interviews/hired". The PDF text is real, selectable text (tested), but nothing here has been tested against any applicant tracking system, and outcomes depend on the applicant and the employer.
- Do not promise a number of improvements, "guaranteed rewrites", or that the AI "never" makes mistakes.
- Do not name the underlying AI model (shop listing rule).
- Do not describe the free sample as an example of what the AI will write for a customer: it is a fictional senior retail resume, not an AI result.

## Notes for the owner
- This wording does not change the price, the five-generation entitlement, or the Tailor allowance (up to 5 runs per paid generation).
- The 3-point rule means small fixes (under 3 points) are applied FREE, and a generation is charged only at 3 points or more. Charging is decided by counting the customer's own accepted changes, never by an AI judgement. Free results are capped (3 per 15 minutes, 10 per day per code) so they cannot become unlimited free AI.
- The lost-reply answer ("about an hour") is true ONLY after supabase/migrations/20261023_03_request_idempotency.sql is applied to production and the new code is deployed (see docs/MIGRATION_03_DEPLOYMENT.md). Before that, the protection lives in memory on one server instance for a few minutes, so keep the older wording until the owner has confirmed the migration.
- The page-length guidance is approximate (about 20,000 characters is roughly 6 pages of plain text) and still needs the long-resume test on a real deploy (`docs/RELEASE_HARDENING.md`).
