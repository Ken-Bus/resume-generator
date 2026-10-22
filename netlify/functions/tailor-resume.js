const { getSupabaseClient, json } = require('./_lib/supabase');
const { get } = require('./_lib/config');
const { readJsonBody } = require('./_lib/http');
const { callClaude, extractJson, assertTailorShape, isObject, isProviderFault } = require('./_lib/ai');
const license = require('./_lib/license');
const tokens = require('./_lib/token');
const integrity = require('./_lib/integrity');
const usage = require('./_lib/usage');
const limits = require('./_lib/limits');
const Core = require('../../resume-core.js');

const MSG = {
  needAnalyze: 'Tailoring is included with each analyzed resume. Analyze your resume with your access code first.',
  expired: 'Your tailoring session has expired. Analyze your resume again to continue.',
  limit: 'You’ve reached the tailoring limit for this resume.',
  unavailable: 'Tailoring is temporarily unavailable. Please try again later.',
  aiFailed: 'We couldn’t tailor your resume right now. Please try again.',
  tooLong: 'This resume (with that job description) is too long to tailor in one go. Please shorten it a little, or paste only the key sections of the job description, and try again.',
  server: 'Server error, please try again.'
};

// Tailoring is authorised by a signed token issued with a paid generation (see parse-resume.js).
// It consumes no generation, but each paid generation allows a limited number of runs.
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const cfg = get();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('tailor-resume: AI key not configured');
    return json(500, { error: MSG.server });
  }
  const secret = process.env.TAILOR_TOKEN_SECRET;
  if (!tokens.isUsable(secret)) {
    console.error('tailor-resume: TAILOR_TOKEN_SECRET is missing or shorter than 32 characters');
    return json(503, { error: MSG.unavailable });
  }

  const parsed = readJsonBody(event, cfg.MAX_BODY_BYTES);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });
  const { resumeData, jobDescription, tailorToken } = parsed.body;

  // Authorisation and input checks all run BEFORE any billable AI call.
  // During a secret rotation, TAILOR_TOKEN_SECRET_PREVIOUS is still accepted (never used to sign).
  const auth = tokens.verify([secret, process.env.TAILOR_TOKEN_SECRET_PREVIOUS], tailorToken);
  if (!auth.ok) {
    return json(401, { error: auth.reason === 'missing' ? MSG.needAnalyze : MSG.expired });
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

  // The database decides whether this paid generation still has tailoring runs left (atomic, replay-proof).
  let supabase;
  let grant;
  try {
    supabase = getSupabaseClient();
    grant = await license.tailorAuthorize(supabase, auth.reservationId, cfg.TAILOR_MAX_PER_PAID_OP);
  } catch (err) {
    console.error('tailor-resume: authorisation failed', { reason: err && err.message });
    return json(503, { error: MSG.server });
  }
  if (grant.outcome === 'limit') return json(429, { error: MSG.limit });
  if (grant.outcome !== 'ok') return json(401, { error: MSG.needAnalyze });

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
    const text = await callClaude({ prompt, maxTokens: cfg.TAILOR_MAX_TOKENS, timeoutMs: cfg.AI_TIMEOUT_MS, fn: 'tailor', ref: auth.reservationId });
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
    await license.safeTailorRefund(supabase, auth.reservationId, providerFault, cfg.TAILOR_FORGIVEN_FAILURES);
    console.error('tailor-resume: generation failed', { ref: guardFault ? 'T107' : undefined, reservation: auth.reservationId, reason: guardFault ? String((err && (err.code || err.name)) || 'error').slice(0, 40) : (err && err.reason) || 'unexpected', providerFault });
    usage.outcome({ fn: 'tailor', ref: auth.reservationId, outcome: 'failed' });
    const long = err && err.name === 'AiError' && (err.reason === 'timeout' || err.reason === 'truncated');
    return json(502, { error: long ? MSG.tooLong : MSG.aiFailed });
  }

  usage.outcome({ fn: 'tailor', ref: auth.reservationId, outcome: 'ok', withheld: withheld.length });
  // `unverified` stays (always empty) for pages loaded before this release; `withheld` lists what was left out and why.
  return json(200, { result: resultText, unverified: [], withheld, tailorRunsRemaining: Math.max(cfg.TAILOR_MAX_PER_PAID_OP - grant.used, 0) });
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
