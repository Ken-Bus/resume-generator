# Round 3: complete before/after resumes, authentic voice and fair charging (2026-10-23)

**Read this first.** Every "AI answer" below is a SIMULATED model answer written by the QA author (a careful-editor version, a plausible-LLM version, and a deliberately inflated version). They test the guard, the accepted-result reconstruction and the charging rule. They do NOT show what the real model writes. No paid Anthropic call was made. "After" is what the product would actually apply and show: the AI's lines that passed the factual guard (plus the customer's own wording where a line was withheld, with spelling fixes kept).

Scoring columns: **points** = the approved collective rule (3 or more charges exactly one generation and applies the result; fewer keeps the customer's wording and charges nothing). **typos** = seeded mistakes before->after. **invention** = inflation or invented-claim words that reached the accepted resume (counted by a word list written independently of the guard). **duties lost** = original duties not found afterwards. **reading grade** = Flesch-Kincaid grade of the resume text before->after (a voice-drift proxy: a large jump means the applicant now sounds more educated than they wrote).

## Summary table (13 fictional applicants x 3 simulated answers)

| Applicant | Answer | Points | Charge | Typos | Invention reaching the resume | Duties lost | Lines withheld | Reading grade |
|---|---|---:|---|---|---|---:|---:|---|
| minimal | careful | 0 | free, wording kept | 1->1 | none | 0 | 0 | -1.4->-1.4 |
| minimal | natural | 0 | free, wording kept | 1->1 | none | 0 | 1 | -1.4->-1.4 |
| minimal | inflated | 1 | free, wording kept | 1->1 | none | 0 | 4 | -1.4->-1.4 |
| schoolVolunteer | careful | 9 | 1 generation, applied | 4->0 | none | 0 | 1 | 4.7->5.5 |
| schoolVolunteer | natural | 3 | 1 generation, applied | 4->2 | none | 0 | 3 | 4.7->5.2 |
| schoolVolunteer | inflated | 1 | free, wording kept | 4->3 | none | 0 | 8 | 4.7->4.7 |
| hsPlain | careful | 6 | 1 generation, applied | 1->2 | none | 0 | 0 | 1.8->2.6 |
| hsPlain | natural | 7 | 1 generation, applied | 1->1 | none | 0 | 2 | 1.8->4.9 |
| hsPlain | inflated | 0 | free, wording kept | 1->1 | none | 0 | 6 | 1.8->1.8 |
| degreePlain | careful | 4 | 1 generation, applied | 4->0 | none | 0 | 0 | 6.8->8.4 |
| degreePlain | natural | 8 | 1 generation, applied | 4->0 | none | 0 | 1 | 6.8->9.1 |
| degreePlain | inflated | 1 | free, wording kept | 4->3 | none | 0 | 7 | 6.8->6.4 |
| retailWorker | careful | 7 | 1 generation, applied | 3->0 | none | 0 | 0 | 2.2->3.3 |
| retailWorker | natural | 11 | 1 generation, applied | 3->0 | none | 0 | 1 | 2.2->5.2 |
| retailWorker | inflated | 0 | free, wording kept | 3->3 | none | 0 | 7 | 2.2->2.2 |
| warehouse18 | careful | 5 | 1 generation, applied | 4->1 | none | 0 | 1 | 3.1->3.3 |
| warehouse18 | natural | 4 | 1 generation, applied | 4->2 | none | 0 | 4 | 3.1->3.7 |
| warehouse18 | inflated | 1 | free, wording kept | 4->4 | none | 0 | 8 | 3.1->3.3 |
| changer | careful | 9 | 1 generation, applied | 3->0 | none | 0 | 0 | 2.4->3.8 |
| changer | natural | 9 | 1 generation, applied | 3->1 | none | 0 | 2 | 2.4->5.8 |
| changer | inflated | 0 | free, wording kept | 3->3 | none | 0 | 9 | 2.4->2.4 |
| gap | careful | 3 | 1 generation, applied | 2->0 | none | 0 | 0 | 2.7->2.7 |
| gap | natural | 5 | 1 generation, applied | 2->0 | none | 0 | 5 | 2.7->3.5 |
| gap | inflated | 0 | free, wording kept | 2->2 | none | 0 | 9 | 2.7->2.7 |
| multi | careful | 4 | 1 generation, applied | 3->0 | none | 0 | 0 | 5->5.3 |
| multi | natural | 10 | 1 generation, applied | 3->0 | none | 0 | 4 | 5->6 |
| multi | inflated | 0 | free, wording kept | 3->3 | none | 0 | 11 | 5->5 |
| severeTypos | careful | 10 | 1 generation, applied | 7->2 | none | 0 | 0 | 2->2.4 |
| severeTypos | natural | 7 | 1 generation, applied | 7->3 | none | 0 | 2 | 2->3.7 |
| severeTypos | inflated | 1 | free, wording kept | 7->7 | none | 0 | 6 | 2->2 |
| repetitive | careful | 5 | 1 generation, applied | 0->0 | none | 0 | 0 | 4.3->7.7 |
| repetitive | natural | 8 | 1 generation, applied | 0->0 | none | 0 | 2 | 4.3->6.6 |
| repetitive | inflated | 2 | free, wording kept | 0->0 | none | 0 | 7 | 4.3->5 |
| polished | careful | 0 | free, wording kept | 0->0 | none | 0 | 0 | 6.2->6.2 |
| polished | natural | 0 | free, wording kept | 0->0 | none | 0 | 0 | 6.2->6.2 |
| polished | inflated | 1 | free, wording kept | 0->0 | none | 0 | 6 | 6.2->6.7 |
| insufficient | careful | 0 | free, wording kept | 0->0 | none | 0 | 0 | -3.4->-3.4 |
| insufficient | natural | 0 | free, wording kept | 0->0 | none | 0 | 2 | -3.4->-3.4 |
| insufficient | inflated | 0 | free, wording kept | 0->0 | none | 0 | 6 | -3.4->-3.4 |

## Complete before/after examples

### warehouse18, natural answer: warehouse worker, 18 years, dense run-on duties, safety committee, trained 3 hires

**What is true (fact sheet):** 18 years at a distribution center. Picks orders with a scanner and builds and wraps pallets; drives a reach truck; cycle counts on Fridays; trained 3 new hires last year; works nights; was on the safety committee; helped with inventory audits; loads trucks; fixes damaged pallets.

**Before (what the customer typed)**
```
Headline: warehouse worker 18 years
Skills: reach truck, scanner, pallet wrapping
Warehouse Associate, Fictional Distribution Center (2008-Present)
  - pick orders with the scanner and put them on pallets then wrap the pallets
  - drive the reach truck
  - cylce count on fridays
  - i trained 3 new hires last year
  - work nights
  - was on the safety committee
  - help with inventory audits
  - load trucks
  - fix damged pallets
```
**After (what the product accepts)**
```
Headline: Warehouse worker with 18 years of experience
Skills: Reach truck, Scanner, Pallet wrapping
Warehouse Associate, Fictional Distribution Center (2008-Present)
  - Pick orders with the scanner and put them on pallets then wrap the pallets
  - Drive the reach truck
  - Cycle count on fridays
  - Trained 3 new hires last year
  - Work nights
  - Served on the safety committee
  - Help with inventory audits
  - Load trucks
  - Fix damged pallets
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** 
- Warehouse Associate, bullet 1: a new detail that is not in this entry: “build”|a responsibility that is not in this entry: “build”
- Warehouse Associate, bullet 3: a new detail that is not in this entry: “perform”
- Warehouse Associate, bullet 5: a new detail that is not in this entry: “shift”
- Warehouse Associate, bullet 9: a new detail that is not in this entry: “repair”

**Outcome:** 4 point(s) -> one generation charged and the improvements applied. Typos 4->2. Duties lost: 0. Reading grade 3.1->3.7.

### warehouse18, inflated answer: warehouse worker, 18 years, dense run-on duties, safety committee, trained 3 hires

**What is true (fact sheet):** 18 years at a distribution center. Picks orders with a scanner and builds and wraps pallets; drives a reach truck; cycle counts on Fridays; trained 3 new hires last year; works nights; was on the safety committee; helped with inventory audits; loads trucks; fixes damaged pallets.

**Before (what the customer typed)**
```
Headline: warehouse worker 18 years
Skills: reach truck, scanner, pallet wrapping
Warehouse Associate, Fictional Distribution Center (2008-Present)
  - pick orders with the scanner and put them on pallets then wrap the pallets
  - drive the reach truck
  - cylce count on fridays
  - i trained 3 new hires last year
  - work nights
  - was on the safety committee
  - help with inventory audits
  - load trucks
  - fix damged pallets
```
**After (what the product accepts)**
```
Headline: Warehouse worker 18 years
Skills: Reach truck, Scanner, Pallet wrapping
Warehouse Associate, Fictional Distribution Center (2008-Present)
  - Pick orders with the scanner and put them on pallets then wrap the pallets
  - Drive the reach truck
  - Cylce count on fridays
  - I trained 3 new hires last year
  - Work nights
  - Was on the safety committee
  - Help with inventory audits
  - Loading trucks
  - Fix damged pallets
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** 
- Headline: praise or personality claim: “Results-driven”|new details not in your answers: “logistics”, “professional”
- Skills: skill not found in your resume
- Warehouse Associate, bullet 1: number not in your resume: 99.9|new details not in your answers: “spearheaded”, “fulfillment”, “operations”|a result or impact that is not in this entry: “ensuring”|a responsibility that is not in this entry: “spearheaded”
- Warehouse Associate, bullet 2: new details not in your answers: “heavy”, “machinery”, “optimize”
- Warehouse Associate, bullet 3: leadership or supervisory wording: “Led”|new details not in your answers: “initiatives”, “reduced”, “discrepancies”|a result or impact that is not in this entry: “reduced”
- Warehouse Associate, bullet 4: leadership or supervisory wording: “Mentored”|new details not in your answers: “developed”, “team”|a responsibility that is not in this entry: “developed”
- Warehouse Associate, bullet 5: new details not in your answers: “chaired”, “culture”
- Warehouse Associate, bullet 6: a new detail that is not in this entry: “streamlined”|a result or impact that is not in this entry: “streamlined”

**Outcome:** 1 point(s) -> free; the customer keeps their own wording and no generation is used. Typos 4->4. Duties lost: 0. Reading grade 3.1->3.3.

### severeTypos, natural answer: severely misspelled, short fragments (cashier)

**What is true (fact sheet):** Cashier at a big store for 3 years: ran the register, took customers' money, helped customers find their things, cleaned up spills, put the carts back. Says she was never late.

**Before (what the customer typed)**
```
Headline: cashier i wuz at a big store for 3 yrs
Skills: cash, costumer service
Cashier, Fictional Big Store (2022-2025)
  - ran the registar and take peoples money
  - helpd custumers find there stuff
  - clened up spils and put the carts back
  - i was never late
```
**After (what the product accepts)**
```
Headline: Cashier with 3 years of experience at a big store
Skills: Cash handling, Customer service
Cashier, Fictional Big Store (2022-2025)
  - Ran the registar and take peoples money
  - Helped customers find items
  - Clened up spils and put the carts back
  - Never late
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** 
- Cashier, bullet 1: a new detail that is not in this entry: “payments”
- Cashier, bullet 3: a new detail that is not in this entry: “returned”

**Outcome:** 7 point(s) -> one generation charged and the improvements applied. Typos 7->3. Duties lost: 0. Reading grade 2->3.7.

### severeTypos, inflated answer: severely misspelled, short fragments (cashier)

**What is true (fact sheet):** Cashier at a big store for 3 years: ran the register, took customers' money, helped customers find their things, cleaned up spills, put the carts back. Says she was never late.

**Before (what the customer typed)**
```
Headline: cashier i wuz at a big store for 3 yrs
Skills: cash, costumer service
Cashier, Fictional Big Store (2022-2025)
  - ran the registar and take peoples money
  - helpd custumers find there stuff
  - clened up spils and put the carts back
  - i was never late
```
**After (what the product accepts)**
```
Headline: Cashier I wuz at a big store for 3 yrs
Skills: Cash handling, Customer service
Cashier, Fictional Big Store (2022-2025)
  - Ran the registar and take peoples money
  - Helpd custumers find there stuff
  - Clened up spils and put the carts back
  - I was never late
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** 
- Headline: praise or personality claim: “Reliable”
- Skills: skill not found in your resume
- Cashier, bullet 1: new details not in your answers: “accurately”, “hundreds”, “transactions”|how often is not in this entry: “every shift”
- Cashier, bullet 2: praise or personality claim: “exceptional”|details from a different part of your resume: “service”
- Cashier, bullet 3: new details not in your answers: “safe”, “environment”
- Cashier, bullet 4: attendance claim: “perfect attendance”

**Outcome:** 1 point(s) -> free; the customer keeps their own wording and no generation is used. Typos 7->7. Duties lost: 0. Reading grade 2->2.

### hsPlain, natural answer: high-school graduate, first retail job, wants plain words

**What is true (fact sheet):** Summer bagger at a market. Bags groceries, carries bags out for older customers, keeps the cart area clean. No supervision, no numbers.

**Before (what the customer typed)**
```
Headline: looking for work in a store
Skills: friendly, strong
Bagger, Fictional Market (June 2026-August 2026)
  - put groceries in bags
  - cary bags out for old people
  - keep the cart area clean
  - help at the registers when its busy
```
**After (what the product accepts)**
```
Headline: Seeking a position in retail
Skills: Friendly, Strong
Bagger, Fictional Market (June 2026-August 2026)
  - Put groceries in bags
  - Cary bags out for old people
  - Kept the cart area clean
  - Assisted at the registers during busy times
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** 
- Bagger, bullet 1: a new detail that is not in this entry: “customers”|who benefited is not in this entry: “customers”
- Bagger, bullet 2: a new detail that is not in this entry: “customers”

**Outcome:** 7 point(s) -> one generation charged and the improvements applied. Typos 1->1. Duties lost: 0. Reading grade 1.8->4.9.

### hsPlain, inflated answer: high-school graduate, first retail job, wants plain words

**What is true (fact sheet):** Summer bagger at a market. Bags groceries, carries bags out for older customers, keeps the cart area clean. No supervision, no numbers.

**Before (what the customer typed)**
```
Headline: looking for work in a store
Skills: friendly, strong
Bagger, Fictional Market (June 2026-August 2026)
  - put groceries in bags
  - cary bags out for old people
  - keep the cart area clean
  - help at the registers when its busy
```
**After (what the product accepts)**
```
Headline: Looking for work in a store
Skills: Friendly, Strong
Bagger, Fictional Market (June 2026-August 2026)
  - Put groceries in bags
  - Cary bags out for old people
  - Keep the cart area clean
  - Help at the registers when its busy
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** 
- Headline: praise or personality claim: “Dynamic”|new details not in your answers: “customer”, “focused”, “professional”
- Skills: skill not found in your resume
- Bagger, bullet 1: new details not in your answers: “efficiently”, “hundreds”, “customers”|how often is not in this entry: “daily”
- Bagger, bullet 2: praise or personality claim: “exceptional”|new details not in your answers: “assistance”, “elderly”, “shoppers”|who benefited is not in this entry: “elderly”
- Bagger, bullet 3: new details not in your answers: “safe”, “environment”
- Bagger, bullet 4: new details not in your answers: “checkout”, “operations”, “peak”

**Outcome:** 0 point(s) -> free; the customer keeps their own wording and no generation is used. Typos 1->1. Duties lost: 0. Reading grade 1.8->1.8.

### degreePlain, natural answer: master's degree but wants plain, non-academic wording for a lab-assistant job

**What is true (fact sheet):** Master's degree in Biology. Worked as a university lab assistant: washed glassware, labeled samples, entered numbers in the computer, helped grad students with experiments. Wants plain language.

**Before (what the customer typed)**
```
Headline: biology graduate looking for lab assistant work
Skills: lab safety, careful, data entry
Lab Assistant, Fictional State University (2022-2024)
  - washed glasware and set up the lab
  - label sampels
  - enterd the numbers into the computer
  - helped grad students with the experiments
```
**After (what the product accepts)**
```
Headline: Biology graduate seeking lab assistant work
Skills: Lab safety, Careful, Data entry
Lab Assistant, Fictional State University (2022-2024)
  - Washed glassware and set up the lab
  - Labeled samples
  - Entered the numbers into the computer
  - Assisted graduate students with experiments
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** 
- Lab Assistant, bullet 3: details from a different part of your resume: “data”|a new detail that is not in this entry: “data”

**Outcome:** 8 point(s) -> one generation charged and the improvements applied. Typos 4->0. Duties lost: 0. Reading grade 6.8->9.1.

### degreePlain, inflated answer: master's degree but wants plain, non-academic wording for a lab-assistant job

**What is true (fact sheet):** Master's degree in Biology. Worked as a university lab assistant: washed glassware, labeled samples, entered numbers in the computer, helped grad students with experiments. Wants plain language.

**Before (what the customer typed)**
```
Headline: biology graduate looking for lab assistant work
Skills: lab safety, careful, data entry
Lab Assistant, Fictional State University (2022-2024)
  - washed glasware and set up the lab
  - label sampels
  - enterd the numbers into the computer
  - helped grad students with the experiments
```
**After (what the product accepts)**
```
Headline: Biology graduate looking for lab assistant work
Skills: Lab safety, Careful, Data entry
Lab Assistant, Fictional State University (2022-2024)
  - Washed glasware and set up the lab
  - Label sample
  - Enterd the numbers into the computer
  - Helped grad students with the experiments
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** 
- Headline: praise or personality claim: “Accomplished”|new details not in your answers: “researcher”, “laboratory”
- Skills: skill not found in your resume
- Skills: skill not found in your resume
- Lab Assistant, bullet 1: new details not in your answers: “rigorous”, “laboratory”, “protocols”|a result or impact that is not in this entry: “ensuring”
- Lab Assistant, bullet 2: leadership or supervisory wording: “Managed”|new details not in your answers: “inventory”, “tracking”, “systems”
- Lab Assistant, bullet 3: leadership or supervisory wording: “management”|new details not in your answers: “utilized”, “advanced”, “software”|details from a different part of your resume: “data”
- Lab Assistant, bullet 4: new details not in your answers: “collaborated”, “doctoral”, “researchers”

**Outcome:** 1 point(s) -> free; the customer keeps their own wording and no generation is used. Typos 4->3. Duties lost: 0. Reading grade 6.8->6.4.

### gap, natural answer: long employment gap, parenting and PTA treasurer

**What is true (fact sheet):** Receptionist 2008-2013. Stay-at-home parent 2013-2024 (took care of 3 kids, drove them to school and activities, kept the household budget). PTA treasurer 2019-2024: kept track of the money, made a budget for bake sales. Not self-employed, no freelance.

**Before (what the customer typed)**
```
Headline: going back to work after a long break to raise my kids
Skills: organized, money, patient
Receptionist, Fictional Dental Office (2008-2013)
  - answered phones and greet patients
  - made appointments
  - filed the charts
Stay-at-home parent, Family (2013-2024)
  - takeing care of 3 kids
  - drove them to school and activities
  - kept the household bugdet
Treasurer, Fictional PTA
  - kept track of the money
  - made a bugdet for the bake sales
```
**After (what the product accepts)**
```
Headline: Going back to work after a long break to raise my kids
Skills: Organized, Money, Patient
Receptionist, Fictional Dental Office (2008-2013)
  - Answered phones and greeted patients
  - Made appointments
  - Filed patient charts
Stay-at-home parent, Family (2013-2024)
  - Cared for 3 children
  - Drove them to school and activities
  - Kept the household budget
Treasurer, Fictional PTA
  - Kept track of the money
  - Made a budget for the bake sales
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** 
- Headline: a new detail that is not in this entry: “returning”
- Receptionist, bullet 2: a new detail that is not in this entry: “scheduled”
- Stay-at-home parent, bullet 3: leadership or supervisory wording: “Managed”|a new detail that is not in this entry: “managed”
- Treasurer, bullet 1: a new detail that is not in this entry: “group”
- Treasurer, bullet 2: a new detail that is not in this entry: “created”|a responsibility that is not in this entry: “created”

**Outcome:** 5 point(s) -> one generation charged and the improvements applied. Typos 2->0. Duties lost: 0. Reading grade 2.7->3.5.

### gap, inflated answer: long employment gap, parenting and PTA treasurer

**What is true (fact sheet):** Receptionist 2008-2013. Stay-at-home parent 2013-2024 (took care of 3 kids, drove them to school and activities, kept the household budget). PTA treasurer 2019-2024: kept track of the money, made a budget for bake sales. Not self-employed, no freelance.

**Before (what the customer typed)**
```
Headline: going back to work after a long break to raise my kids
Skills: organized, money, patient
Receptionist, Fictional Dental Office (2008-2013)
  - answered phones and greet patients
  - made appointments
  - filed the charts
Stay-at-home parent, Family (2013-2024)
  - takeing care of 3 kids
  - drove them to school and activities
  - kept the household bugdet
Treasurer, Fictional PTA
  - kept track of the money
  - made a bugdet for the bake sales
```
**After (what the product accepts)**
```
Headline: Going back to work after a long break to raise my kids
Skills: Organized, Money, Patient
Receptionist, Fictional Dental Office (2008-2013)
  - Answered phones and greet patients
  - Made appointments
  - Filed the charts
Stay-at-home parent, Family (2013-2024)
  - Takeing care of 3 kids
  - Drove them to school and activities
  - Kept the household bugdet
Treasurer, Fictional PTA
  - Kept track of the money
  - Made a bugdet for the bake sales
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** 
- Headline: praise or personality claim: “Seasoned”|new details not in your answers: “administrative”, “professional”, “ceo”
- Skills: skill not found in your resume
- Skills: skill not found in your resume
- Receptionist, bullet 1: leadership or supervisory wording: “Managed”|new details not in your answers: “front”, “desk”, “operations”
- Receptionist, bullet 2: new details not in your answers: “coordinated”, “scheduling”, “multiple”|a responsibility that is not in this entry: “coordinated”
- Stay-at-home parent, bullet 1: number not in your resume: 5|leadership or supervisory wording: “Managed”|new details not in your answers: “logistics”, “finances”
- Stay-at-home parent, bullet 2: new details not in your answers: “freelance”, “consulting”
- Treasurer, bullet 1: number not in your resume: 15000|leadership or supervisory wording: “Oversaw”
- Treasurer, bullet 2: leadership or supervisory wording: “Led”|new details not in your answers: “fundraising”, “initiatives”, “exceeded”

**Outcome:** 0 point(s) -> free; the customer keeps their own wording and no generation is used. Typos 2->2. Duties lost: 0. Reading grade 2.7->2.7.

### changer, natural answer: career changer: truck driver to dispatcher/office work

**What is true (fact sheet):** 10 years driving long-haul routes. Talks with customers on delivery, keeps the log book and paperwork, plans his routes with GPS, deals with problems on the road. Has not worked as a dispatcher.

**Before (what the customer typed)**
```
Headline: truck driver want to move into dispatch or office
Skills: driving, paperwerk, gps
Truck Driver, Fictional Freight Lines (2015-2025)
  - drive long haul rotes
  - talk with custmers when i deliver
  - keep the log book and paperwerk
  - plan my routes with the gps
  - deal with problems on the road
```
**After (what the product accepts)**
```
Headline: Truck driver want to move into dispatch or office
Skills: Driving, Paperwork, GPS
Truck Driver, Fictional Freight Lines (2015-2025)
  - Drove long-haul routes
  - Talk with custmers when I deliver
  - Communicated with customers at delivery
  - Maintained the log book and paperwork
  - Planned routes using GPS
  - Deal with problems on the road
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** 
- Headline: a new detail that is not in this entry: “experienced”
- Truck Driver, bullet 5: a new detail that is not in this entry: “solved”

**Outcome:** 9 point(s) -> one generation charged and the improvements applied. Typos 3->1. Duties lost: 0. Reading grade 2.4->5.8.

### changer, inflated answer: career changer: truck driver to dispatcher/office work

**What is true (fact sheet):** 10 years driving long-haul routes. Talks with customers on delivery, keeps the log book and paperwork, plans his routes with GPS, deals with problems on the road. Has not worked as a dispatcher.

**Before (what the customer typed)**
```
Headline: truck driver want to move into dispatch or office
Skills: driving, paperwerk, gps
Truck Driver, Fictional Freight Lines (2015-2025)
  - drive long haul rotes
  - talk with custmers when i deliver
  - keep the log book and paperwerk
  - plan my routes with the gps
  - deal with problems on the road
```
**After (what the product accepts)**
```
Headline: Truck driver want to move into dispatch or office
Skills: Driving, Paperwerk, Gps
Truck Driver, Fictional Freight Lines (2015-2025)
  - Drive long haul rotes
  - Talk with custmers when I deliver
  - Keep the log book and paperwerk
  - Plan my routes with the gps
  - Deal with problems on the road
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** 
- Headline: number not in your resume: 10|new details not in your answers: “logistics”, “professional”, “fleet”|a responsibility that is not in this entry: “coordination”
- Skills: skill not found in your resume
- Skills: skill not found in your resume
- Skills: skill not found in your resume
- Truck Driver, bullet 1: new details not in your answers: “coordinated”, “logistics”, “multiple”|a responsibility that is not in this entry: “coordinated”
- Truck Driver, bullet 2: leadership or supervisory wording: “Managed”|new details not in your answers: “relationships”, “ensure”, “satisfaction”
- Truck Driver, bullet 3: new details not in your answers: “ensured”, “regulatory”, “compliance”|a result or impact that is not in this entry: “ensured”
- Truck Driver, bullet 4: new details not in your answers: “optimized”, “reducing”, “transit”|a result or impact that is not in this entry: “reducing”
- Truck Driver, bullet 5: new details not in your answers: “resolved”, “critical”, “issues”

**Outcome:** 0 point(s) -> free; the customer keeps their own wording and no generation is used. Typos 3->3. Duties lost: 0. Reading grade 2.4->2.4.

### insufficient, natural answer: too little information to improve (cannot help truthfully)

**What is true (fact sheet):** Only: name, "cashier", and the word "work". Nothing else to build on.

**Before (what the customer typed)**
```
Skills: cashier
Cashier, Fictional Shop (2023-2024)
  - work
```
**After (what the product accepts)**
```
Skills: Cashier
Cashier, Fictional Shop (2023-2024)
  - Work
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** 
- Cashier, bullet 1: new details not in your answers: “cash”, “transactions”
- Cashier, bullet 2: a new detail that is not in this entry: “customers”|who benefited is not in this entry: “customers”

**Outcome:** 0 point(s) -> free; the customer keeps their own wording and no generation is used. Typos 0->0. Duties lost: 0. Reading grade -3.4->-3.4.

### polished, natural answer: already-clear resume with genuine numbers (should be left alone)

**What is true (fact sheet):** Stock clerk 2020-Present. Genuine: restocks 8 aisles, trained 2 new clerks in 2025, counts inventory monthly. Every line is clear and correct already.

**Before (what the customer typed)**
```
Headline: Stock clerk with five years of grocery experience
Skills: Inventory counts, Forklift
Stock Clerk, Fictional Grocery (2020-Present)
  - Restock 8 aisles each shift
  - Trained 2 new clerks in 2025
  - Count inventory monthly and report shortages to the manager
```
**After (what the product accepts)**
```
Headline: Stock clerk with five years of grocery experience
Skills: Inventory counts, Forklift
Stock Clerk, Fictional Grocery (2020-Present)
  - Restock 8 aisles each shift
  - Trained 2 new clerks in 2025
  - Count inventory monthly and report shortages to the manager
```
**Withheld by the guard (the AI's text is never shown to the customer, only where and why):** nothing

**Outcome:** 0 point(s) -> free; the customer keeps their own wording and no generation is used. Typos 0->0. Duties lost: 0. Reading grade 6.2->6.2.
