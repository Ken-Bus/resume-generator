const release = require('./_lib/release');
const { getSupabaseClient, CODE_RE, normalizeCode, json } = require('./_lib/supabase');
const { makeLimiter, clientIp } = require('./_lib/rate');
const { get } = require('./_lib/config');
const { readJsonBody } = require('./_lib/http');
const { callClaude, extractJson, assertTailorShape, isObject, isProviderFault, isBusy } = require('./_lib/ai');
const license = require('./_lib/license');
const tokens = require('./_lib/token');
const integrity = require('./_lib/integrity');
const usage = require('./_lib/usage');
const limits = require('./_lib/limits');
const Core = require('../../resume-core.js');

const MSG = {
  needAnalyze: 'Tailoring is included with each analyzed resume. Analyze your resume with your access code first.',
  expired: 'Your tailoring session has expired. Analyze your resume again to continue.',
  limit: 'You’ve used all your tailoring runs. Each analyzed resume, and each AI Polish that uses a generation, includes up to 5.',
  ended: 'The four-day finishing period for this code has ended, so tailoring is no longer available. Additional access codes are available in the Flex & Grace Etsy shop.',
  notFound: 'We couldn’t find that code.',
  badFormat: 'That code doesn’t look right. Check the format: FG-XXXX-XXXX.',
  slow: 'Too many attempts in a short time. Please wait a moment and try again.',
  unavailable: 'Tailoring is temporarily unavailable. Please try again later.',
  aiBusy: 'The AI service is very busy right now. Please wait a minute or two and try again. Your resume is still here.',
  aiFailed: 'We couldn’t tailor your resume right now. Please try again.',
  slow: 'The AI took too long to answer. Nothing was used. Please try again in a moment.',
  tooLong: 'This resume (with that job description) is too long to tailor in one go. Please shorten it a little, or paste only the key sections of the job description, and try again.',
  server: 'Server error, please try again.'
};

// Guessing codes: unknown or malformed codes are limited per client, like verify-license (best effort, in memory; see _lib/rate.js).
const failedChecks = makeLimiter({ windowMs: 10 * 60 * 1000, max: 30 });

// Tailoring consumes no generation, but each qualifying paid step (an Analyze, or a Polish that used a generation) allows a limited number of runs.
// It is authorised in one of two ways:
//   * by the customer's ACCESS CODE (migration 06): the database finds the oldest paid step of THAT code with a run left, so unused runs survive a
//     closed browser, a break and a new day. Allowed while the code is active and in its four-day completion period, refused once access has ended.
//   * by a signed, two-hour token issued with a paid generation (pages and servers from before migration 06; also the fallback while migration 06
//     is not applied). Unchanged.
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return release.notAllowed();
  }

  const cfg = get();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('tailor-resume: AI key not configured');
    return json(500, { error: MSG.server });
  }
  const secret = process.env.TAILOR_TOKEN_SECRET;

  const parsed = readJsonBody(event, cfg.MAX_BODY_BYTES);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });
  const { resumeData, jobDescription, tailorToken, clientGuard, code: rawCode } = parsed.body;
  if (release.staleClient(clientGuard)) return json(409, { error: release.STALE_MESSAGE, stale: true, guard: release.stamp() });

  const ip = clientIp(event);
  const byCode = typeof rawCode === 'string' && rawCode.trim() !== '';
  const code = byCode ? normalizeCode(rawCode) : null;
  if (byCode) {
    const waitFor = failedChecks.wait(ip);
    if (waitFor) return json(429, { error: MSG.slow }, { 'Retry-After': String(waitFor) });
    if (!CODE_RE.test(code)) { failedChecks.hit(ip); return json(400, { error: MSG.badFormat }); }
  }

  // Token authorisation. During a secret rotation, TAILOR_TOKEN_SECRET_PREVIOUS is still accepted (never used to sign).
  const verifyToken = () => {
    if (!tokens.isUsable(secret)) {
      console.error('tailor-resume: TAILOR_TOKEN_SECRET is missing or shorter than 32 characters');
      return { response: json(503, { error: MSG.unavailable }) };
    }
    const auth = tokens.verify([secret, process.env.TAILOR_TOKEN_SECRET_PREVIOUS], tailorToken);
    if (!auth.ok) return { response: json(401, { error: auth.reason === 'missing' ? MSG.needAnalyze : MSG.expired }) };
    return { auth };
  };

  // Authorisation and input checks all run BEFORE any billable AI call. A token-only request is authorised first, as it always was.
  let tokenAuth = null;
  if (!byCode) {
    const v = verifyToken();
    if (v.response) return v.response;
    tokenAuth = v.auth;
  }
  if (typeof jobDescription !== 'string' || !jobDescription.trim()) {
    return json(400, { error: 'No job description provided' });
  }
  if (jobDescription.length > cfg.JOB_DESC_MAX_CHARS) {
    return json(413, { error: `That job description is too long (limit ${cfg.JOB_DESC_MAX_CHARS.toLocaleString('en-US')} characters). Please paste the key sections only.` });
  }
  if (!isObject(resumeData)) return json(400, { error: 'Malformed request' });
  if (JSON.stringify(resumeData).length > cfg.RESUME_JSON_MAX_CHARS) {
    return json(413, { error: 'That resume is too long to tailor. Please shorten it and try again.' });
  }
  // Work on the cleaned resume: no blank rows, only known fields, and the AI's answer lines up entry by entry with what we compare it to.
  const source = Core.clean(resumeData);
  if (!Core.hasContent(source)) return json(400, { error: 'Please add some details to your resume first.' });
  const resumeJson = JSON.stringify(source);
  // The reply is about as long as the resume; if it cannot fit in the output cap the call is certain to be cut off. Refuse BEFORE a run is used.
  if (!limits.fitsOutput(resumeJson.length + 350, cfg.TAILOR_MAX_TOKENS)) return json(413, { error: MSG.tooLong });

  // The database decides whether a paid generation still has tailoring runs left (atomic, replay-proof).
  let supabase;
  let grant = null;                 // { reservationId, used }
  try {
    supabase = getSupabaseClient();
    if (byCode) {
      // Access first (as export-resume does): once the four-day period is over nothing is used. null = migration 05 is not applied.
      const access = await license.accessStatus(supabase, code);
      if (access && access.state === 'not_found') { failedChecks.hit(ip); return json(401, { error: MSG.notFound }); }
      if (access && access.state === 'ended') return json(403, { error: MSG.ended }, { 'X-Access-State': 'ended' });
      const g = await license.tailorAuthorizeForCode(supabase, code, cfg.TAILOR_MAX_PER_PAID_OP);
      if (g === null) {             // migration 06 is not applied: keep the earlier, token-based behaviour (and use nothing without a valid token)
        const v = verifyToken();
        if (v.response) return v.response;
        tokenAuth = v.auth;
      } else {
        if (g.outcome === 'limit') return json(429, { error: MSG.limit, tailorRunsAvailable: 0 });
        if (g.outcome !== 'ok') return json(401, { error: MSG.needAnalyze, tailorRunsAvailable: 0 });
        grant = { reservationId: g.reservationId, used: g.used };
      }
    }
    if (!grant) {
      const g = await license.tailorAuthorize(supabase, tokenAuth.reservationId, cfg.TAILOR_MAX_PER_PAID_OP);
      if (g.outcome === 'limit') return json(429, { error: MSG.limit });
      if (g.outcome !== 'ok') return json(401, { error: MSG.needAnalyze });
      grant = { reservationId: tokenAuth.reservationId, used: g.used };
    }
  } catch (err) {
    console.error('tailor-resume: authorisation failed', { reason: String((err && (err.code || err.name)) || 'error').slice(0, 40) });
    return json(503, { error: MSG.server });
  }
  const reservationId = grant.reservationId;

  const prompt = `You are a resume tailoring assistant. You will be given a candidate's resume as structured JSON, and a target job description. Your job:

1. Rewrite the "summary.bullets", "summary.skills", and each experience entry's "bullets" to naturally emphasize skills, keywords, and phrasing that match the job description — WITHOUT inventing new experience, employers, titles, or fabricating anything not implied by the original resume. Keep facts (dates, companies, titles, degrees) exactly as given. Never add a number, percentage, dollar amount, certification, license, supervisory duty or responsibility that is not already stated in the original resume.
2. Keep the exact same JSON schema/structure as the input resume — only the wording of bullets, tagline, and skills should change.
3. Also produce a "matchSummary" object with: "matchedKeywords" (array of strings — keywords/skills from the job description that ARE reflected in the resume), "missingKeywords" (array of strings — important keywords/skills from the job description that are NOT present in the candidate's background and could not be truthfully added), and "notes" (a short 1-2 sentence plain-English summary of overall fit).

4. Keep each person's level of involvement: if they wrote "helped", "assisted" or "was part of", never turn it into "organized", "planned", "ran", "created", "built" or "led". Never add who benefited or what resulted ("for families", "in the community", "resulting in", "improving") unless that is stated in the SAME entry. Use details only from the entry a line belongs to, never from a different job or project. Leave any blank field blank. Job description keywords may shape the wording only where they are already true of that entry; never add a skill, tool or duty from the job description.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{"resume": <the full resume object with the same schema as input, bullets/summary/skills rewritten>, "matchSummary": {"matchedKeywords":["string"],"missingKeywords":["string"],"notes":"string"}}

Resume JSON:
${resumeJson}

Job description:
${jobDescription}`;

  let resultText;
  let withheld = [];
  try {
    const text = await callClaude({ prompt, maxTokens: cfg.TAILOR_MAX_TOKENS, timeoutMs: cfg.AI_TIMEOUT_MS, fn: 'tailor', ref: reservationId });
    const shaped = assertTailorShape(extractJson(text));
    // The same protections as AI Polish: facts come back from the customer's resume, and every line that borrows a detail from another
    // entry, inflates a role, adds a beneficiary or result, or fills something left blank is put back to the customer's own wording.
    const guarded = integrity.guardResume(source, shaped.resume, { mode: 'tailor' });
    shaped.resume = guarded.resume; withheld = guarded.withheld;
    shaped.matchSummary = groundMatchSummary(guarded.resume, shaped.matchSummary);
    resultText = JSON.stringify(shaped);
  } catch (err) {
    // A provider outage (or a fault in our own checks) is always given back. Other failures are given back only a couple of times
    // per paid generation, so repeated failures cannot create unlimited AI calls.
    const guardFault = !(err && err.name === 'AiError');
    const providerFault = guardFault || isProviderFault(err);
    await license.safeTailorRefund(supabase, reservationId, providerFault, cfg.TAILOR_FORGIVEN_FAILURES);
    console.error('tailor-resume: generation failed', { ref: guardFault ? 'T107' : undefined, reservation: reservationId, reason: guardFault ? String((err && (err.code || err.name)) || 'error').slice(0, 40) : (err && err.reason) || 'unexpected', providerFault });
    usage.outcome({ fn: 'tailor', ref: reservationId, outcome: 'failed' });
    const reason = err && err.name === 'AiError' ? err.reason : '';
    return json(502, { error: reason === 'truncated' ? MSG.tooLong : reason === 'timeout' ? MSG.slow : isBusy(err) ? MSG.aiBusy : MSG.aiFailed });
  }

  usage.outcome({ fn: 'tailor', ref: reservationId, outcome: 'ok', withheld: withheld.length });
  // `unverified` stays (always empty) for pages loaded before this release; `withheld` lists what was left out and why.
  // Runs left for the whole code (by-code requests only; best effort, it never fails a finished run).
  let tailorRunsAvailable;
  if (byCode) { try { const n = await license.tailorRunsAvailable(supabase, code, cfg.TAILOR_MAX_PER_PAID_OP); if (n !== null) tailorRunsAvailable = n; } catch (e) { /* the run already succeeded */ } }
  return json(200, { result: resultText, unverified: [], withheld, tailorRunsRemaining: Math.max(cfg.TAILOR_MAX_PER_PAID_OP - grant.used, 0), ...(tailorRunsAvailable !== undefined ? { tailorRunsAvailable } : {}) });
};

// "Matched keywords" must be reflected in the accepted resume. Anything the AI listed as matched that is not actually there moves to
// "not covered", so the page never tells a customer a keyword is covered when it is not.
function groundMatchSummary(resume, ms) {
  const text = JSON.stringify(resume).toLowerCase();
  const words = (k) => (String(k).toLowerCase().match(/[a-z0-9+#.]{2,}/g) || []);
  const present = (k) => { const w = words(k); return w.length > 0 && w.every((x) => text.includes(x.replace(/(ing|ed|es|s)$/, ''))); };
  const matched = []; const missing = ms.missingKeywords.slice();
  ms.matchedKeywords.forEach((k) => (present(k) ? matched : missing).push(k));
  return { ...ms, matchedKeywords: matched, missingKeywords: [...new Set(missing)] };
}

exports._failedChecks = failedChecks;     // for tests
