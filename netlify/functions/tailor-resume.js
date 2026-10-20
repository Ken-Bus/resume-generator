const { getSupabaseClient, json } = require('./_lib/supabase');
const { get } = require('./_lib/config');
const { readJsonBody } = require('./_lib/http');
const { callClaude, extractJson, assertTailorShape, isObject, isProviderFault } = require('./_lib/ai');
const license = require('./_lib/license');
const tokens = require('./_lib/token');

const MSG = {
  needAnalyze: 'Tailoring is included with each analyzed resume. Analyze your resume with your access code first.',
  expired: 'Your tailoring session has expired. Analyze your resume again to continue.',
  limit: 'You’ve reached the tailoring limit for this resume.',
  unavailable: 'Tailoring is temporarily unavailable. Please try again later.',
  aiFailed: 'We couldn’t tailor your resume right now. Please try again.',
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
  const resumeJson = JSON.stringify(resumeData);
  if (resumeJson.length > cfg.RESUME_JSON_MAX_CHARS) {
    return json(413, { error: 'That resume is too long to tailor. Please shorten it and try again.' });
  }

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

1. Rewrite the "summary.bullets", "summary.skills", and each experience entry's "bullets" to naturally emphasize skills, keywords, and phrasing that match the job description — WITHOUT inventing new experience, employers, titles, or fabricating anything not implied by the original resume. Keep facts (dates, companies, titles, degrees) exactly as given.
2. Keep the exact same JSON schema/structure as the input resume — only the wording of bullets, tagline, and skills should change.
3. Also produce a "matchSummary" object with: "matchedKeywords" (array of strings — keywords/skills from the job description that ARE reflected in the resume), "missingKeywords" (array of strings — important keywords/skills from the job description that are NOT present in the candidate's background and could not be truthfully added), and "notes" (a short 1-2 sentence plain-English summary of overall fit).

Return ONLY valid JSON, no markdown fences, in this exact shape:
{"resume": <the full resume object with the same schema as input, bullets/summary/skills rewritten>, "matchSummary": {"matchedKeywords":["string"],"missingKeywords":["string"],"notes":"string"}}

Resume JSON:
${resumeJson}

Job description:
${jobDescription}`;

  let resultText;
  try {
    const text = await callClaude({ prompt, maxTokens: cfg.TAILOR_MAX_TOKENS, timeoutMs: cfg.AI_TIMEOUT_MS });
    resultText = JSON.stringify(assertTailorShape(extractJson(text)));
  } catch (err) {
    // A provider outage is always given back. Other failures are given back only a couple of times per paid
    // generation, so repeated failures cannot create unlimited AI calls.
    const providerFault = isProviderFault(err);
    await license.safeTailorRefund(supabase, auth.reservationId, providerFault, cfg.TAILOR_FORGIVEN_FAILURES);
    console.error('tailor-resume: generation failed', { reservation: auth.reservationId, reason: (err && err.reason) || 'unexpected', providerFault });
    return json(502, { error: MSG.aiFailed });
  }

  return json(200, { result: resultText, tailorRunsRemaining: Math.max(cfg.TAILOR_MAX_PER_PAID_OP - grant.used, 0) });
};
