const release = require('./_lib/release');
const { getSupabaseClient, CODE_RE, normalizeCode, json } = require('./_lib/supabase');
const { get } = require('./_lib/config');
const { readJsonBody } = require('./_lib/http');
const { callClaude, extractJson, assertResumeShape, isProviderFault } = require('./_lib/ai');
const license = require('./_lib/license');
const tokens = require('./_lib/token');
const integrity = require('./_lib/integrity');
const nochange = require('./_lib/nochange');
const scoring = require('./_lib/scoring');
const usage = require('./_lib/usage');
const limits = require('./_lib/limits');
const { isFirstInFlight } = require('./_lib/inflight');
const { makeLimiter, clientIp } = require('./_lib/rate');
const Core = require('../../resume-core.js');

const { stamp } = release;

// Fewer words than this in the whole resume (names, dates and schools excluded) is too little for an AI to improve without inventing.
const MIN_WORDS = 8;

// "Polish My Resume with AI": turns the customer's own guided answers into clear resume wording.
// PAID OPERATION, charged exactly like Analyze: ONE of the code's included generations, and only after a
// validated result whose ACCEPTED improvements add up to at least 3 points (_lib/scoring.js: a real rewrite is 3; each genuine
// spelling, grammar or tense correction, removed repetition or vague word made specific is 1; capitals, punctuation, synonyms and
// anything unsupported are 0). A result below that releases the reservation uncharged and uncounted (it never touches the
// database failure budget), is capped separately in _lib/nochange.js, and is never applied to the resume.
// Same reserve -> AI -> commit / release model, same signed tailoring token (so Tailor stays free,
// token-gated and capped). Nothing here changes how Analyze or Tailor are charged.
//
// Duplicate-charge protection (on top of the browser's single-flight button):
//   * one paid operation at a time per code (see _lib/inflight.js): a double-click or a retry while a request is
//     still running is rejected uncharged;
//   * an optional requestId makes a retry of an already-completed polish return the SAME result without a second
//     charge (best-effort: kept in memory on the instance that served it, for a few minutes).

// Error messages from the database can echo query values (such as the license code), so only a code or name is logged.
// Guessing codes through this endpoint: an unknown or malformed code counts against the client (best effort, in memory; see _lib/rate.js).
const failedCodes = makeLimiter({ windowMs: 10 * 60 * 1000, max: 30 });
const safeReason = (e) => String((e && (e.code || e.name)) || 'error').slice(0, 40);

// Every server-side failure answers with the same friendly text plus a short reference (for example "ref P101").
// The reference reveals nothing about configuration, but the same code is written to the function log with the
// reason, so a support check can tell a missing setting from a database problem at a glance.
//   P101 AI provider key not set for this deploy     P102 database client unavailable     P103 reservation failed
//   P104 unexpected reservation outcome              P105 duplicate-request check failed  P106 charge could not be recorded
const refMsg = (ref) => `Server error, please try again. (ref ${ref})`;

const MSG = {
  refresh: 'Please refresh the page and enter your access code again.',
  badFormat: 'That code doesn’t look right. Check the format: FG-XXXX-XXXX.',
  notFound: 'We couldn’t find that code.',
  exhausted: 'You’ve used all generations on this code.',
  busy: 'Another generation is already in progress on this code. Please wait a moment and try again.',
  nothing: 'Add a few answers first (for example what you did in a job, a project, or your skills), then try again.',
  sparse: 'There isn’t enough detail for the AI to improve yet, and it will not make anything up to fill the gap. Add a few words about what you did (what you worked with, and what you did each day), then try again. Nothing was used.',
  aiFailed: 'We couldn’t polish your resume right now. You haven’t been charged. Please try again.',
  noChange: 'The AI reviewed your resume and found nothing meaningful to improve, so your wording is unchanged and no generation was used.',
  minorOnly: 'The AI found only a few small fixes (fewer than it takes to use a generation: a generation is used when the AI rewrites some of your wording or corrects three or more mistakes), so your wording is unchanged and no generation was used.',
  flaggedOnly: 'The AI suggested changes, but they added details that are not in your answers, and what was left was too little to use a generation, so your wording is unchanged and no generation was used.',
  slow: 'The AI took too long to answer. You haven’t been charged. Please try again in a moment. If it keeps happening, try again with fewer or shorter entries.',
  tooLong: 'This resume is too long to polish in one go (the AI could not finish it in time or space). You haven’t been charged. Try again with fewer or shorter entries, for example your most recent jobs first.',
  tooLongInput: 'This resume is too long to polish in one go. You haven’t been charged. Shorten it a little (fewer or shorter entries) and try again.',
  notCharged: 'Something went wrong on our side. Please check the counter above before trying again.',
  server: 'Server error, please try again.'
};

const replay = require('./_lib/replay');
const cacheKey = (code, id) => ['polish', code, id];
function cacheGet(k) { return replay.get(...k); }
function cachePut(k, body) { replay.put(...k, body); }

// Who is this resume for? The customer can say (first resume / worked before / changing to different work); otherwise it
// follows from the answers. Only these three values are ever used, so the field cannot inject text into the prompt.
const PROFILES = ['first', 'experienced', 'changer'];
function chooseProfile(requested, source) {
  const hasWork = source.experience.length > 0;
  if (!PROFILES.includes(requested)) return hasWork ? 'experienced' : 'first';
  if (requested !== 'first' && !hasWork) return 'first';          // nothing to build an "experienced" or "career change" story from
  return requested;
}

const AUDIENCE = {
  first: `AUDIENCE: This is the person's FIRST resume. Employers will look for evidence of reliability, willingness to learn and basic skills, and a first-time applicant has that evidence in school, volunteering, projects, training, hobbies and family or community responsibilities. State plainly and confidently what the person actually did. Do not make school or volunteer activity sound like paid professional work, and do not apologise for having no work history.`,
  experienced: `AUDIENCE: This person HAS WORK HISTORY. Make each job's bullets specific and easy to scan: what they did, with what (any tools, equipment or systems they named), in plain active verbs. Join fragments and repeated lines, put the most relevant line first, and keep every specific the person gave. Do not turn routine duties into achievements. If the person stayed in one place for years, keep each role and its dates separate and describe the work as it was.`,
  changer: `AUDIENCE: This person is CHANGING to a different kind of work. Keep their real experience, and word the duties so the parts that carry over are easy to see (for example dealing with customers, keeping accurate records, following safety rules; mention training others only if they said so). Never claim experience in the new field. In the one-line introduction, name the kind of work they are aiming for (from their stated goal) and one strength they actually listed.`
};

// Words that make a resume sound generated. The model must not use them unless the customer wrote them. (The server
// also flags any that slip through; see _lib/integrity.js.)
const AVOID_WORDS = 'motivated, passionate, dynamic, results-driven, proven track record, hard-working, detail-oriented, self-starter, team player, go-getter, ' +
  'dedicated, committed, exceptional, excellent, outstanding, highly skilled, extensive experience, successfully, spearheaded, leveraged, utilized, synergy, fast-paced environment';

function buildPrompt(source, target, profile) {
  return `You are a careful resume editor. You will receive a person's OWN answers as structured JSON. Rewrite them so an employer can read them quickly and understand what the person did, in natural, professional, plain English.

${AUDIENCE[profile]}

FACT RULES (never break these)
1. Use ONLY facts that appear in the JSON. Never invent or change employers, job titles, dates, schools, qualifications, certifications, licenses, awards or locations. Copy those fields exactly as given.
2. Never add numbers, percentages, dollar amounts, team sizes, frequencies or any metric that is not already in the answers.
3. Never add leadership, supervision, training of others, attendance or punctuality records, awards, accomplishments or responsibilities that the answers do not state. Never add a skill the person did not list or clearly describe doing.
4. Do not add any job, project, volunteer entry, school or skill the person did not list. If a section is empty, leave it empty: having no work history is normal.
5. Keep the person's level of involvement. If they wrote "helped", "assisted", "was part of" or "worked with", keep that level; never turn it into "organized", "planned", "ran", "created", "built" or "led" (so "helped organize food" must not become "organized food").
6. Never add who benefited or what resulted ("for families", "in the community", "to help people", "resulting in", "ensuring", "improving") unless that same beneficiary or result is stated in THIS entry. A word that appears only in a different entry, or in another organization's name, does not count for this entry.
7. If a description, summary or an entry's bullets are blank, leave them blank. Do not write new text for something the person left empty.

HOW TO WRITE
Improve what is actually said, not how impressive it sounds. Turn the person's own answers into a clear, well-organised, professional resume that an employer can read in seconds. Read EVERY line and ask whether an employer could understand it faster or more exactly. Say who or what the person worked with and what they did, using only the words and details they gave, including details the person gave in other fields of the SAME entry (for example that entry's description or another of its bullets), never details from a different entry. Tighten a line that is wordy, repeats another line, or uses a vague verb such as "did", "helped with" or "worked on" when the person's own words name the specific action. If a line is already clear and specific, leave it as it is: never reword a line just to change it. But do not skip a line that can honestly be made clearer. Go through EVERY part (headline, skills, and each job, project and volunteer description and bullet) and do all of the following, using only the person's own facts:
8. SPELLING AND GRAMMAR. Correct every mistake, including a single misspelled word ("resturant", "experiance", "boxs"), a wrong word form ("peoples", "they was correct"), a missing capital, "i" for "I", and missing or wrong punctuation. Fix small mistakes too. Names of companies, schools, places and people stay exactly as written.
9. FORM AND TENSE. Write each bullet as a short phrase that starts with a plain action verb, with no "I" ("Loaded trucks", not "I load trucks"). Use past tense for past jobs and activities, and present tense for an entry whose end date is "Present". Keep one tense inside an entry.
10. RUN-ONS AND FRAGMENTS. A line that holds several separate duties becomes separate bullets, one duty each. A fragment such as "cash" or "stock" becomes a short phrase built only from that word ("Handled cash", "Stocked items").
11. REPETITION. When two lines say the same thing, keep ONE clear line that carries every specific from both. Never delete a duty that is stated only once: if the person did it, it stays.
12. VAGUE WORDS. Replace "stuff", "things", "did", "worked on" or "helped with" with a plain, specific word only when the person's own words or the entry's other lines name it. If nothing does, use a neutral word ("items", "products", "tasks") rather than an invented detail.
13. ORDER. Within each entry put the most relevant duties first and keep similar duties together. Keep entries in the order given.
14. LEAVE CLEAR LINES ALONE. A line that is already correct, clear and specific stays exactly as written; fix capitalization and punctuation only where they are wrong. Do not replace a good word with a synonym, and do not rewrite a line only to change it. If the whole resume is already clear and correct, return it unchanged.
15. Keep the person's own distinctive words (names of tools, equipment, places, subjects) and their exact meaning. Keep their meaning exactly; a reworded line must say the same thing as the original, only more clearly.
16. Use natural, modest, professional language that is also plain, the way a calm, careful person would say it to an interviewer. No corporate jargon and no inflated verbs. Do not add praise or personality words. Avoid these generic phrases unless the person wrote them themselves: ${AVOID_WORDS}. Do not add quality adjectives such as "excellent", "strong" or "effective".
17. ${target ? `The person is looking for: "${target}". Where it is truthful, put the most relevant facts first and choose wording that fits that kind of work, using only the facts above.` : 'No target job was given, so keep the wording general.'}
18. The one-line introduction (summary.tagline) may only restate the goal and strengths the person gave, with spelling and grammar fixed; if they gave neither, leave it as it is. Do not write a summary paragraph. Skills: fix spelling and capitals and remove exact repeats; never add a skill.

EXAMPLES of the difference (fictional)
- Answer: "I load trucks and unloaded them and also i count the stock every week then I reported damaged boxs to the supervisor"
  Good: three bullets: "Loaded and unloaded trucks", "Counted stock every week", "Reported damaged boxes to the supervisor"
  Bad: "Managed inventory and logistics operations, ensuring zero losses." (adds scope, a result and a metric)
- Answer: "cash, stock, help people find stuff, clean"
  Good: "Handled cash", "Stocked items", "Helped people find products", "Cleaned up"
  Bad: "Handled cash for 200 customers daily in a busy store." (adds a number and a setting)
- Answer: "Made bread" and "made the bread in the morning" (the same duty twice)
  Good: one bullet: "Made bread in the morning"
  Bad: deleting both because they look repetitive, or adding "for local customers"
- Answer: a job ending "Present" with "answered phones, greet visitors"
  Good: "Answer phones and greet visitors"
  Bad: "Provided exceptional front-desk support" (praise, and a different job description)
- Answer: headline "cashier with experiance"
  Good: "Cashier with experience"
- Answer: "helped customers find stuff, put stuff on shelves"
  Good: "Helped customers find products and restocked shelves."
  Bad: "Provided exceptional customer service in a fast-paced retail environment." (adds praise and a setting the person never described)
- Answer: "ran the register, counted the drawer at night"
  Good: "Operated the register and counted the cash drawer at closing."
  Bad: "Managed cash handling operations with 100% accuracy." (adds a claim and a metric)
- Answer: "helped organize food for pickup"
  Good: keep "Helped organize food for pickup" (never turn "helped" into "organized")
  Bad: "Organized donated food for families in the community." (raises the role and adds who benefited)
- Answer: "asked classmates to donate cans, sorted them"
  Good: "Asked classmates to donate canned food and sorted the donations."
  Bad: "Spearheaded a school-wide food drive, leading a team of volunteers." (adds leadership and scale)
- Answer: project description "Collected canned food for a local pantry" with the bullet "Asked classmates to donate cans" (already grammatical, but plainer than the entry's own details)
  Good: "Asked classmates to donate canned food for a local pantry." (uses a detail from the same entry; same meaning)
  Bad: "Led a school-wide drive that fed 200 families." (adds leadership, scale and a metric)
- Answer: "Operated the register and counted the cash drawer at closing."
  Good: leave this line exactly as written (already specific, active and clear)

Keep exactly the same JSON schema and keys as the input. Return ONLY valid JSON, no markdown fences, no commentary.

Resume JSON:
${JSON.stringify(source)}`;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return release.notAllowed();
  }

  const cfg = get();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('polish-resume: AI key not configured', { ref: 'P101' });
    return json(500, { error: refMsg('P101'), ref: 'P101' });
  }

  const parsed = readJsonBody(event, cfg.MAX_BODY_BYTES);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });
  const { code: rawCode, resume, target: rawTarget, requestId, profile: rawProfile, clientGuard } = parsed.body;
  if (release.staleClient(clientGuard)) return json(409, { error: release.STALE_MESSAGE, stale: true, guard: stamp() });

  // 1. Every check that can reject the request runs BEFORE any billable AI call.
  const code = normalizeCode(rawCode);
  if (!code) return json(401, { error: MSG.refresh, guard: stamp() });
  const ip = clientIp(event);
  const guessing = failedCodes.wait(ip);
  if (guessing) return json(429, { error: 'Too many attempts in a short time. Please wait a moment and try again.' }, { 'Retry-After': String(guessing) });
  if (!CODE_RE.test(code)) { failedCodes.hit(ip); return json(400, { error: MSG.badFormat }); }
  if (!resume || typeof resume !== 'object' || Array.isArray(resume)) return json(400, { error: 'Malformed request' });
  if (JSON.stringify(resume).length > cfg.RESUME_JSON_MAX_CHARS) return json(413, { error: 'That resume is too long to polish. Please shorten it and try again.' });
  const source = Core.clean(resume);
  if (!Core.hasWritableText(source)) return json(400, { error: MSG.nothing });
  // Too little to work with: say so plainly instead of calling the AI (nothing to improve truthfully, and a call would cost money for no benefit).
  if (Core.writableWords(source) < MIN_WORDS) return json(200, { guard: stamp(), noChange: true, charged: false, reason: 'sparse', message: MSG.sparse, withheld: [], changes: { reworded: 0, minor: 0, cosmetic: 0, unchanged: 0, dropped: 0 }, points: 0, threshold: scoring.THRESHOLD });
  // The reply is about as long as the resume. If it cannot fit in the output cap the call is certain to be cut off, so refuse now:
  // no reservation, no AI call, no cost.
  if (!limits.fitsOutput(JSON.stringify(source).length, cfg.TAILOR_MAX_TOKENS)) return json(413, { error: MSG.tooLongInput });
  const target = typeof rawTarget === 'string' ? rawTarget.replace(/["\\`]/g, "'").replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const profile = chooseProfile(typeof rawProfile === 'string' ? rawProfile : '', source);
  const rid = replay.validId(requestId);

  let supabase;
  try { supabase = getSupabaseClient(); } catch (err) {
    console.error('polish-resume: database client unavailable', { ref: 'P102' });
    return json(503, { error: refMsg('P102'), ref: 'P102' });
  }

  // A repeat of a polish that already finished returns the same result, uncharged.
  if (rid) {
    const hit = cacheGet(cacheKey(code, rid));
    if (hit) {
      try { if (await license.readLicense(supabase, code)) return json(200, hit); } catch (e) { /* fall through to the normal path */ }
    }
  }

  // Free-but-costly requests are capped separately: a code that keeps getting "nothing to improve" must change something first.
  const capped = nochange.check(code, cfg);
  if (!capped.allowed) {
    const minutes = Math.ceil(capped.retryAfterSeconds / 60);
    return json(429, {
      error: `The AI has already reviewed this resume several times without being able to use any of its suggestions. To protect your account, please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}. You can keep editing your resume and downloading it in the meantime. You haven’t been charged.`,
      retryAfterSeconds: capped.retryAfterSeconds
    }, { 'Retry-After': String(capped.retryAfterSeconds) });
  }

  let reservation;
  try {
    reservation = await license.reserve(supabase, code, cfg);
  } catch (err) {
    const missing = err && (err.code === '42883' || err.code === 'PGRST202');
    console.error(missing
      ? 'polish-resume: reserve_license_use is missing. Apply supabase/migrations/20261020_01_license_reservations.sql BEFORE deploying this code.'
      : 'polish-resume: reservation failed', { ref: 'P103', reason: safeReason(err) });
    return json(503, { error: refMsg('P103'), ref: 'P103' });
  }

  if (reservation.outcome === 'not_found') { failedCodes.hit(ip); return json(403, { error: MSG.notFound }); }
  if (reservation.outcome === 'exhausted') return json(403, { error: MSG.exhausted, usesRemaining: 0, maxUses: reservation.maximum });
  if (reservation.outcome === 'throttled') {
    const wait = Math.max(Number(reservation.retryAfterSeconds) || 60, 1);
    const minutes = Math.ceil(wait / 60);
    return json(429, {
      error: `We’ve had several unsuccessful attempts on this code in a short time. To protect your account, please wait about ${minutes} minute${minutes === 1 ? '' : 's'} and try again. You haven’t been charged.`,
      retryAfterSeconds: wait, usesRemaining: reservation.remaining, maxUses: reservation.maximum
    }, { 'Retry-After': String(wait) });
  }
  if (reservation.outcome === 'busy') return json(409, { error: MSG.busy, usesRemaining: reservation.remaining, maxUses: reservation.maximum });
  if (reservation.outcome !== 'reserved') {
    console.error('polish-resume: unexpected reservation outcome', { ref: 'P104', outcome: reservation.outcome });
    return json(503, { error: refMsg('P104'), ref: 'P104' });
  }

  // One paid operation at a time per code: only the earliest live reservation proceeds.
  try {
    if (!(await isFirstInFlight(supabase, code, reservation.reservationId))) {
      await license.safeRelease(supabase, reservation.reservationId, false);
      return json(409, { error: MSG.busy, usesRemaining: reservation.remaining, maxUses: reservation.maximum });
    }
  } catch (err) {
    console.error('polish-resume: in-flight check failed', { ref: 'P105', reason: safeReason(err) });
    await license.safeRelease(supabase, reservation.reservationId, false);          // never leave a reservation held
    return json(503, { error: refMsg('P105'), ref: 'P105' });
  }

  // 2. Run the AI and guard its answer. ANY failure releases the reservation and the customer is not charged.
  let polished;
  let withheld = [];
  let changes;
  let score;
  try {
    const text = await callClaude({ prompt: buildPrompt(source, target, profile), maxTokens: cfg.TAILOR_MAX_TOKENS, timeoutMs: cfg.AI_TIMEOUT_MS, fn: 'polish', ref: reservation.reservationId });
    const shaped = assertResumeShape(extractJson(text));
    // Only what passes the integrity checks is accepted: facts come back from the customer's answers, and every line that borrows,
    // inflates or invents is put back to the customer's own wording. If this step itself fails we refuse to ship unguarded AI text.
    const guarded = integrity.guardResume(source, shaped, { mode: 'polish', vocabulary: target });
    polished = guarded.resume; withheld = guarded.withheld;
    changes = integrity.assessChange(source, polished);
    score = scoring.score(source, polished, Core.clean(shaped));                              // what the ACCEPTED edits are worth (never the withheld ones)
  } catch (err) {
    const guardFault = !(err && err.name === 'AiError');                   // a bug in our own checks is not the customer's failure
    const providerFault = guardFault || isProviderFault(err);
    await license.safeRelease(supabase, reservation.reservationId, !providerFault);
    console.error('polish-resume: generation failed', { ref: guardFault ? 'P107' : undefined, reservation: reservation.reservationId, reason: guardFault ? safeReason(err) : (err && err.reason) || 'unexpected', counted: !providerFault });
    usage.outcome({ fn: 'polish', ref: reservation.reservationId, outcome: 'failed' });
    const reason = err && err.name === 'AiError' ? err.reason : '';
    return json(502, { error: reason === 'truncated' ? MSG.tooLong : reason === 'timeout' ? MSG.slow : MSG.aiFailed });
  }

  // 2b. The ACCEPTED improvements are worth less than the charging threshold (the AI changed nothing, or only capitals/punctuation, or only a
  // couple of small fixes, or every change it made was withheld by the integrity checks): release the reservation, uncharged and NOT counted as a
  // failure, and hand back no text (the customer's own wording stays). It is capped separately (_lib/nochange.js) so it cannot become unlimited
  // free AI. Counts only go to the log (P201 / P202).
  if (!score.charge) {
    const seen = changes.reworded + changes.minor + changes.dropped;       // anything the customer could have seen change
    const flaggedOnly = withheld.length > 0;                               // some suggestions were left out, and what remained was too little to use a generation
    const smallOnly = !flaggedOnly && seen > 0;
    await license.safeRelease(supabase, reservation.reservationId, false);
    nochange.record(code);
    console.warn(flaggedOnly ? 'polish-resume: every change was withheld by the integrity checks; released, not charged' : smallOnly ? 'polish-resume: accepted changes are below the charging threshold; released, not charged' : 'polish-resume: result had NO wording changes; released, not charged',
      { ref: flaggedOnly ? 'P202' : 'P201', reservation: reservation.reservationId, ...changes, points: score.points, withheld: withheld.length });
    usage.outcome({ fn: 'polish', ref: reservation.reservationId, outcome: flaggedOnly ? 'flagged' : 'nochange', guard: Core.GUARD_VERSION, reworded: changes.reworded, points: score.points, withheld: withheld.length });
    const body = { guard: stamp(), noChange: true, charged: false, reason: flaggedOnly ? 'flagged' : smallOnly ? 'minor' : 'unchanged', message: flaggedOnly ? MSG.flaggedOnly : smallOnly ? MSG.minorOnly : MSG.noChange, withheld, changes, points: score.points, threshold: score.threshold, usesRemaining: reservation.remaining, maxUses: reservation.maximum };
    if (rid) cachePut(cacheKey(code, rid), body);
    return json(200, body);
  }

  // 3. Charge only now. Commit is idempotent, so one retry after a transient error is safe.
  let committed;
  for (let attempt = 0; attempt < 2 && !committed; attempt++) {
    try { committed = await license.commit(supabase, reservation.reservationId); }
    catch (err) { console.error('polish-resume: commit attempt failed', { reservation: reservation.reservationId, attempt }); }
  }
  if (!committed) {
    console.error('polish-resume: charge could not be recorded', { ref: 'P106', reservation: reservation.reservationId });
    await license.safeRelease(supabase, reservation.reservationId, false);
    return json(503, { error: `${MSG.notCharged} (ref P106)`, ref: 'P106' });
  }
  if (committed.outcome === 'exhausted') return json(403, { error: MSG.exhausted, usesRemaining: 0, maxUses: committed.maximum });
  if (committed.outcome !== 'committed' && committed.outcome !== 'already_committed') {
    console.error('polish-resume: commit refused', { reservation: reservation.reservationId, outcome: committed.outcome });
    return json(409, { error: MSG.aiFailed });
  }

  // 4. Tailoring authorisation bound to this paid generation (identical to Analyze).
  let tailorToken = null;
  const secret = process.env.TAILOR_TOKEN_SECRET;
  if (tokens.isUsable(secret)) tailorToken = tokens.sign(secret, reservation.reservationId, cfg.TAILOR_TOKEN_TTL_SECONDS);
  else console.error('polish-resume: TAILOR_TOKEN_SECRET is missing or shorter than 32 characters; tailoring is disabled');

  usage.outcome({ fn: 'polish', ref: reservation.reservationId, outcome: 'charged', guard: Core.GUARD_VERSION, reworded: changes.reworded, points: score.points, withheld: withheld.length });
  // `unverified` stays in the response (always empty now) for pages loaded before this release; `withheld` lists what was left out.
  const body = { guard: stamp(), result: JSON.stringify(polished), unverified: [], withheld, changes, points: score.points, threshold: score.threshold, charged: true, usesRemaining: committed.remaining, maxUses: committed.maximum, tailorToken };
  if (rid) cachePut(cacheKey(code, rid), body);
  return json(200, body);
};

exports._recent = replay.recent;     // for tests
exports._nochange = nochange;
exports._buildPrompt = buildPrompt;
exports._chooseProfile = chooseProfile;
exports._MIN_WORDS = MIN_WORDS;
exports._failedCodes = failedCodes;
