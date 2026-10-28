# Everyday jobs: which template to choose, and what the app does for first-time applicants

Prepared on branch `feature/everyday-jobs-templates` (separate from Migration 05). Wording only plus small page changes; no new templates, no AI prompt, charging or database change.

## What was found (verified in the code and by rendering the templates)
- All 12 templates are plain, **single-column** layouts with real, selectable text (no tables, columns or images in the preview; the PDF/Word export tests already read the text back). They suit ordinary jobs well.
- The problem was **finding** them: the tabs were industry names (Corporate first and selected by default, Trades last), template names ("The Operator", "The Foreman") said nothing about the kind of work, and the only sample was a vice-president resume with figures like "$42M revenue" and "team of 120".
- The Guided Builder already serves everyday workers: examples such as cashier, warehouse associate and food service, tick-boxes for real duties, a "Not yet. That's okay!" path for people with no work history, and a section model that never shows an empty Experience section (a first resume leads with Education, then Projects, Volunteer & Activities, Certifications). No change was needed there.
- AI Polish already carries everyday examples (loading trucks, running a register, helping customers) and the first-resume rules. Job Match ("Tailor to This Job") is generic and works for any job description. No prompt change was made.

## What changed
1. Each template now has a one-line "good for" note, shown under the template buttons.
2. Tab names on screen: Corporate -> **Office & Business**, Healthcare -> **Care & Service**, Trades -> **Everyday & Trades** (ids stored in drafts and exports are unchanged).
3. "Try Sample" now loads an everyday resume (a warehouse associate who used to be a cashier; fictional, no invented numbers). The old executive resume is kept as **Office Sample**. Neither calls the AI.

## Existing templates for everyday jobs
| Template (tab) | Good for |
|---|---|
| The Operator (Everyday & Trades) | Retail, warehouse, food service, delivery and first jobs |
| The Foreman (Everyday & Trades) | Construction, maintenance, manufacturing and housekeeping; certifications and training come first |
| The Partner (Office & Business) | Office work, customer service and first jobs |
| The Boardroom (Office & Business) | Office, administration and business jobs |
| The Practitioner (Care & Service) | Customer service, caregiving, housekeeping and health support |
| The Educator (Care & Service) | Childcare, tutoring, caregiving and first jobs |
| The Builder / The Architect (Tech) | Office, IT help desk, technical support |

## Suggested Etsy FAQ entry (not published)
**Q: Is this only for corporate jobs?**
A: No. It is built for everyday jobs too: retail, warehouse, food service, delivery, housekeeping, maintenance, construction, manufacturing, customer service, office work and first jobs. Choose "Create My First Resume" if you have no work history; it leads with your school, projects, volunteering and skills and never asks you to invent a job. Every template is a plain one-column layout with real text (no pictures of text), which applicant tracking systems can read. We cannot promise how any employer's system will treat a resume, or that you will get an interview. The wording always uses only what you tell us.

## Remaining limitations
- Job Match needs the permission that comes with a paid Analyze or Polish step, so a Guided Builder customer who has not polished yet cannot use it (existing rule, unchanged here).
- Job Match rewrites a first-time applicant's skills and summary but does not reword projects or volunteering (existing prompt, unchanged; no failure was demonstrated).
- The section heading "Professional Summary" is the same for every resume, including a first resume. Changing it would touch every export and test, so it was left.
- Template recommendations are suggestions, not tested outcomes; no template improves a candidate's chances on its own.
- The Etsy FAQ draft's "Claims to avoid" line that calls the sample "a fictional senior retail resume" is now out of date (the default sample is a warehouse/cashier resume). It is left alone here to avoid a merge conflict with the charging-wording branch; update it when that branch lands.
