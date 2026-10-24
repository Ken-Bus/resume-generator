const release = require('./_lib/release');
const { getSupabaseClient, CODE_RE, normalizeCode, json } = require('./_lib/supabase');
const { get } = require('./_lib/config');
const { readJsonBody } = require('./_lib/http');
const { callClaude, extractJson, assertResumeShape, isProviderFault, isBusy } = require('./_lib/ai');
const license = require('./_lib/license');
const tokens = require('./_lib/token');
const integrity = require('./_lib/integrity');
const usage = require('./_lib/usage');
const { isFirstInFlight } = require('./_lib/inflight');
const replay = require('./_lib/replay');
const recovery = require('./_lib/recovery');
const { makeLimiter, clientIp } = require('./_lib/rate');

// Guessing codes through this endpoint: an unknown or malformed code counts against the client (best effort, in memory; see _lib/rate.js).
// A customer who mistypes a code a few times is never affected.
const failedCodes = makeLimiter({ windowMs: 10 * 60 * 1000, max: 30 });
// Database error messages can echo query values (such as the license code), so only a code or name is ever logged.
const safeReason = (e) => String((e && (e.code || e.name)) || 'error').slice(0, 40);

const MSG = {
  refresh: 'Please refresh the page and enter your access code again.',
  badFormat: 'That code doesn’t look right. Check the format: FG-XXXX-XXXX.',
  notFound: 'We couldn’t find that code.',
  exhausted: 'You’ve used all generations on this code.',
  busy: 'Another generation is already in progress on this code. Please wait a moment and try again.',
  aiBusy: 'The AI service is very busy right now. You haven’t been charged. Please wait a minute or two and try again. Your resume is still here.',
  aiFailed: 'We couldn’t analyze this resume right now. You haven’t been charged. Please try again.',
  slow: 'The AI took too long to answer. You haven’t been charged. Please try again in a moment.',
  tooLong: 'This resume is too long for the AI to analyze in one go (it could not finish in time or space). You haven’t been charged. Try pasting fewer or shorter entries, for example your most recent jobs first.',
  notCharged: 'Something went wrong on our side. Please check the counter above before trying again.',
  server: 'Server error, please try again.'
};

// Paid operation: a generation is reserved before the AI runs and only charged after a validated result.
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return release.notAllowed();
  }

  const cfg = get();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('parse-resume: AI key not configured');
    return json(500, { error: MSG.server });
  }

  const parsed = readJsonBody(event, cfg.MAX_BODY_BYTES);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });
  const { code: rawCode, resumeText, clientGuard, requestId } = parsed.body;
  if (release.staleClient(clientGuard)) return json(409, { error: release.STALE_MESSAGE, stale: true, guard: release.stamp() });

  // 1. Every check that can reject the request runs BEFORE any billable AI call.
  const code = normalizeCode(rawCode);
  if (!code) return json(401, { error: MSG.refresh });
  const ip = clientIp(event);
  const guessing = failedCodes.wait(ip);
  if (guessing) return json(429, { error: 'Too many attempts in a short time. Please wait a moment and try again.' }, { 'Retry-After': String(guessing) });
  if (!CODE_RE.test(code)) { failedCodes.hit(ip); return json(400, { error: MSG.badFormat }); }
  if (typeof resumeText !== 'string' || !resumeText.trim()) {
    return json(400, { error: 'Please paste your resume text first.' });
  }
  if (resumeText.length > cfg.RESUME_MAX_CHARS) {
    return json(413, { error: `That resume is too long to analyze (limit ${cfg.RESUME_MAX_CHARS.toLocaleString('en-US')} characters). Please trim older or less relevant sections and try again.` });
  }

  const rid = replay.validId(requestId);
  let supabase;
  let reservation;
  try {
    supabase = getSupabaseClient();
    // A repeat of an Analyze that already finished (the reply was lost) returns the same result, uncharged.
    if (rid) {
      const hit = replay.get('analyze', code, rid, resumeText);
      if (hit) { try { if (await license.readLicense(supabase, code)) return json(200, { ...hit, recovered: 'exact', message: recovery.RECOVERED.exact }); } catch (e) { /* fall through to the normal path */ } }
    }
    reservation = await license.reserve(supabase, code, cfg, replay.repeatOf('analyze', rid, resumeText));
  } catch (err) {
    // 42883 / PGRST202 = the function does not exist, i.e. the database migration has not been applied yet.
    const missing = err && (err.code === '42883' || err.code === 'PGRST202');
    console.error(missing
      ? 'parse-resume: reserve_license_use is missing. Apply supabase/migrations/20261020_01_license_reservations.sql BEFORE deploying this code.'
      : 'parse-resume: reservation failed', { reason: safeReason(err) });
    return json(503, { error: MSG.server });
  }

  if (reservation.outcome === 'not_found') { failedCodes.hit(ip); return json(403, { error: MSG.notFound }); }
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
  if (reservation.outcome === 'busy' || reservation.outcome === 'replay_busy') {
    return json(409, { error: MSG.busy, usesRemaining: reservation.remaining, maxUses: reservation.maximum });
  }
  const refused = recovery.blocked(reservation, 'analyze'); if (refused) return json(refused.status, refused.body);
  // 'replay': this very step was already paid for (the reply was lost and the retry reached another instance or a restarted one). The AI runs
  // again to re-deliver the result; nothing more is charged.
  const redelivery = reservation.outcome === 'replay';
  if (reservation.outcome !== 'reserved' && !redelivery) {
    console.error('parse-resume: unexpected reservation outcome', { outcome: reservation.outcome });
    return json(503, { error: MSG.server });
  }

  // One paid operation at a time per code (as in AI Polish): a double-send or a second tab is turned away uncharged, never run twice.
  const giveBack = (counted) => (redelivery ? license.finishRedelivery(supabase, reservation.reservationId, false) : license.safeRelease(supabase, reservation.reservationId, counted));
  try {
    if (!redelivery && !(await isFirstInFlight(supabase, code, reservation.reservationId))) {
      await license.safeRelease(supabase, reservation.reservationId, false);
      return json(409, { error: MSG.busy, usesRemaining: reservation.remaining, maxUses: reservation.maximum });
    }
  } catch (err) {
    console.error('parse-resume: in-flight check failed', { reason: safeReason(err) });
    await license.safeRelease(supabase, reservation.reservationId, false);          // never leave a reservation held
    return json(503, { error: MSG.server });
  }

  const prompt = `You are a resume parser. Extract structured JSON from this resume. Copy only what is written in the resume: if something is not there, leave it as an empty string or empty list, and never guess an email, phone number, website, date or number. Return ONLY valid JSON, no markdown fences.\n\nSchema: {"name":"string","contact":{"phone":"string","email":"string","location":"string","linkedin":"string","website":"string"},"summary":{"tagline":"string","bullets":["string"],"skills":["string"]},"experience":[{"title":"string","company":"string","location":"string","start":"string","end":"string","summary":"string","bullets":["string"]}],"education":[{"degree":"string","school":"string","location":"string","date":"string","honors":"string"}],"certifications":[{"name":"string","org":"string","date":"string"}],"projects":[{"name":"string","description":"string","bullets":["string"]}],"volunteer":[{"title":"string","organization":"string","location":"string","start":"string","end":"string","bullets":["string"]}],"awards":["string"]}\n\nResume:\n${resumeText}`;

  // 2. Run the AI. ANY failure releases the reservation and the customer is not charged.
  let resultText;
  let unverified = [];
  try {
    const text = await callClaude({ prompt, maxTokens: cfg.PARSE_MAX_TOKENS, timeoutMs: cfg.AI_TIMEOUT_MS, fn: 'analyze', ref: reservation.reservationId });
    // The parsed resume is checked against the text that was pasted: invented contact details and dates are removed, unsupported
    // numbers are flagged, and only known fields (as text) survive.
    const grounded = integrity.groundAnalyzed(resumeText, assertResumeShape(extractJson(text)));
    resultText = JSON.stringify(grounded.resume); unverified = grounded.unverified;
    if (grounded.removed.length) console.warn('parse-resume: removed details that were not in the pasted text', { ref: 'A201', count: grounded.removed.length });
  } catch (err) {
    // Provider outages (and faults in our own checks) are released uncounted; anything that may have cost money counts toward the per-code budget.
    const guardFault = !(err && err.name === 'AiError');
    const providerFault = guardFault || isProviderFault(err);
    await giveBack(!providerFault);
    console.error('parse-resume: generation failed', { ref: guardFault ? 'A107' : undefined, reservation: reservation.reservationId, reason: guardFault ? String((err && (err.code || err.name)) || 'error').slice(0, 40) : (err && err.reason) || 'unexpected', counted: !providerFault });
    usage.outcome({ fn: 'analyze', ref: reservation.reservationId, outcome: 'failed' });
    const reason = err && err.name === 'AiError' ? err.reason : '';
    if (redelivery) return json(502, recovery.failed(reservation, 'analyze', isBusy(err)));
    return json(502, { error: reason === 'truncated' ? MSG.tooLong : reason === 'timeout' ? MSG.slow : isBusy(err) ? MSG.aiBusy : MSG.aiFailed });
  }

  // 3. Charge only now. Commit is idempotent, so one retry after a transient error is safe.
  let committed = redelivery ? { outcome: 'already_committed', remaining: reservation.remaining, maximum: reservation.maximum } : undefined;
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

  if (redelivery) await license.finishRedelivery(supabase, reservation.reservationId, true);
  usage.outcome({ fn: 'analyze', ref: reservation.reservationId, outcome: redelivery ? 'redelivered' : 'charged', withheld: unverified.length });
  const body = {
    result: resultText,
    unverified,
    usesRemaining: committed.remaining,
    maxUses: committed.maximum,
    tailorToken
  };
  if (redelivery) return json(200, { ...body, recovered: 'regenerated', message: recovery.RECOVERED.regenerated, supportRef: recovery.reference(reservation.reservationId) });
  if (rid) replay.put('analyze', code, rid, resumeText, body);
  return json(200, body);
};

exports._failedCodes = failedCodes;     // for tests
