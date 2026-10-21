const { getSupabaseClient, CODE_RE, normalizeCode, json } = require('./_lib/supabase');
const { get } = require('./_lib/config');
const { readJsonBody } = require('./_lib/http');
const { callClaude, extractJson, assertResumeShape, isProviderFault } = require('./_lib/ai');
const license = require('./_lib/license');
const tokens = require('./_lib/token');

const MSG = {
  refresh: 'Please refresh the page and enter your access code again.',
  badFormat: 'That code doesn’t look right. Check the format: FG-XXXX-XXXX.',
  notFound: 'We couldn’t find that code.',
  exhausted: 'You’ve used all generations on this code.',
  busy: 'Another generation is already in progress on this code. Please wait a moment and try again.',
  aiFailed: 'We couldn’t analyze this resume right now. You haven’t been charged. Please try again.',
  notCharged: 'Something went wrong on our side. Please check the counter above before trying again.',
  server: 'Server error, please try again.'
};

// Paid operation: a generation is reserved before the AI runs and only charged after a validated result.
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const cfg = get();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('parse-resume: AI key not configured');
    return json(500, { error: MSG.server });
  }

  const parsed = readJsonBody(event, cfg.MAX_BODY_BYTES);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });
  const { code: rawCode, resumeText } = parsed.body;

  // 1. Every check that can reject the request runs BEFORE any billable AI call.
  const code = normalizeCode(rawCode);
  if (!code) return json(401, { error: MSG.refresh });
  if (!CODE_RE.test(code)) return json(400, { error: MSG.badFormat });
  if (typeof resumeText !== 'string' || !resumeText.trim()) {
    return json(400, { error: 'Please paste your resume text first.' });
  }
  if (resumeText.length > cfg.RESUME_MAX_CHARS) {
    return json(413, { error: `That resume is too long to analyze (limit ${cfg.RESUME_MAX_CHARS.toLocaleString('en-US')} characters). Please trim older or less relevant sections and try again.` });
  }

  let supabase;
  let reservation;
  try {
    supabase = getSupabaseClient();
    reservation = await license.reserve(supabase, code, cfg);
  } catch (err) {
    // 42883 / PGRST202 = the function does not exist, i.e. the database migration has not been applied yet.
    const missing = err && (err.code === '42883' || err.code === 'PGRST202');
    console.error(missing
      ? 'parse-resume: reserve_license_use is missing. Apply supabase/migrations/20261020_01_license_reservations.sql BEFORE deploying this code.'
      : 'parse-resume: reservation failed', { reason: err && err.message });
    return json(503, { error: MSG.server });
  }

  if (reservation.outcome === 'not_found') return json(403, { error: MSG.notFound });
  if (reservation.outcome === 'exhausted') {
    return json(403, { error: MSG.exhausted, usesRemaining: 0, maxUses: reservation.maximum });
  }
  if (reservation.outcome === 'throttled') {
    // Too many costly failures on this code recently. No AI call is made and nothing is charged.
    const wait = Math.max(Number(reservation.retryAfterSeconds) || 60, 1);
    const minutes = Math.ceil(wait / 60);
    return json(429, {
      error: `We’ve had several unsuccessful attempts on this code in a short time. To protect your account, please wait about ${minutes} minute${minutes === 1 ? '' : 's'} and try again. You haven’t been charged.`,
      retryAfterSeconds: wait, usesRemaining: reservation.remaining, maxUses: reservation.maximum
    }, { 'Retry-After': String(wait) });
  }
  if (reservation.outcome === 'busy') {
    return json(409, { error: MSG.busy, usesRemaining: reservation.remaining, maxUses: reservation.maximum });
  }
  if (reservation.outcome !== 'reserved') {
    console.error('parse-resume: unexpected reservation outcome', { outcome: reservation.outcome });
    return json(503, { error: MSG.server });
  }

  const prompt = `You are a resume parser. Extract structured JSON from this resume. Return ONLY valid JSON, no markdown fences.\n\nSchema: {"name":"string","contact":{"phone":"string","email":"string","location":"string","linkedin":"string","website":"string"},"summary":{"tagline":"string","bullets":["string"],"skills":["string"]},"experience":[{"title":"string","company":"string","location":"string","start":"string","end":"string","summary":"string","bullets":["string"]}],"education":[{"degree":"string","school":"string","location":"string","date":"string","honors":"string"}],"certifications":[{"name":"string","org":"string","date":"string"}],"projects":[{"name":"string","description":"string","bullets":["string"]}],"volunteer":[{"title":"string","organization":"string","location":"string","start":"string","end":"string","bullets":["string"]}],"awards":["string"]}\n\nResume:\n${resumeText}`;

  // 2. Run the AI. ANY failure releases the reservation and the customer is not charged.
  let resultText;
  try {
    const text = await callClaude({ prompt, maxTokens: cfg.PARSE_MAX_TOKENS, timeoutMs: cfg.AI_TIMEOUT_MS });
    resultText = JSON.stringify(assertResumeShape(extractJson(text)));
  } catch (err) {
    // Provider outages are released uncounted; anything that may have cost money counts toward the per-code budget.
    const providerFault = isProviderFault(err);
    await license.safeRelease(supabase, reservation.reservationId, !providerFault);
    console.error('parse-resume: generation failed', { reservation: reservation.reservationId, reason: (err && err.reason) || 'unexpected', counted: !providerFault });
    return json(502, { error: MSG.aiFailed });
  }

  // 3. Charge only now. Commit is idempotent, so one retry after a transient error is safe.
  let committed;
  for (let attempt = 0; attempt < 2 && !committed; attempt++) {
    try {
      committed = await license.commit(supabase, reservation.reservationId);
    } catch (err) {
      console.error('parse-resume: commit attempt failed', { reservation: reservation.reservationId, attempt });
    }
  }
  if (!committed) {
    await license.safeRelease(supabase, reservation.reservationId, false); // our database trouble, not a costly failure; no-op if the commit landed
    return json(503, { error: MSG.notCharged });
  }

  if (committed.outcome === 'exhausted') {
    return json(403, { error: MSG.exhausted, usesRemaining: 0, maxUses: committed.maximum });
  }
  if (committed.outcome !== 'committed' && committed.outcome !== 'already_committed') {
    // 'expired' = the lease lapsed and another request took the last slot; nothing was charged here.
    console.error('parse-resume: commit refused', { reservation: reservation.reservationId, outcome: committed.outcome });
    return json(409, { error: MSG.aiFailed });
  }

  // 4. Tailoring authorisation, bound to this paid generation. A missing secret never blocks the paid analysis.
  let tailorToken = null;
  const secret = process.env.TAILOR_TOKEN_SECRET;
  if (tokens.isUsable(secret)) {
    tailorToken = tokens.sign(secret, reservation.reservationId, cfg.TAILOR_TOKEN_TTL_SECONDS);
  } else {
    console.error('parse-resume: TAILOR_TOKEN_SECRET is missing or shorter than 32 characters; tailoring is disabled');
  }

  return json(200, {
    result: resultText,
    usesRemaining: committed.remaining,
    maxUses: committed.maximum,
    tailorToken
  });
};
