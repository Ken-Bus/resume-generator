const crypto = require('crypto');
const { getSupabaseClient, CODE_RE, normalizeCode, json } = require('./_lib/supabase');
const { get } = require('./_lib/config');
const { readJsonBody } = require('./_lib/http');
const { callClaude, extractJson, assertResumeShape, isProviderFault } = require('./_lib/ai');
const license = require('./_lib/license');
const tokens = require('./_lib/token');
const integrity = require('./_lib/integrity');
const { isFirstInFlight } = require('./_lib/inflight');
const Core = require('../../resume-core.js');

// "Polish My Resume with AI": turns the customer's own guided answers into clear resume wording.
// PAID OPERATION, charged exactly like Analyze: ONE of the code's included generations, and only after a
// validated result. Same reserve -> AI -> commit / release model, same signed tailoring token (so Tailor stays free,
// token-gated and capped). Nothing here changes how Analyze or Tailor are charged.
//
// Duplicate-charge protection (on top of the browser's single-flight button):
//   * one paid operation at a time per code (see _lib/inflight.js): a double-click or a retry while a request is
//     still running is rejected uncharged;
//   * an optional requestId makes a retry of an already-completed polish return the SAME result without a second
//     charge (best-effort: kept in memory on the instance that served it, for a few minutes).

// Error messages from the database can echo query values (such as the license code), so only a code or name is logged.
const safeReason = (e) => String((e && (e.code || e.name)) || 'error').slice(0, 40);

const MSG = {
  refresh: 'Please refresh the page and enter your access code again.',
  badFormat: 'That code doesn’t look right. Check the format: FG-XXXX-XXXX.',
  notFound: 'We couldn’t find that code.',
  exhausted: 'You’ve used all generations on this code.',
  busy: 'Another generation is already in progress on this code. Please wait a moment and try again.',
  nothing: 'Add a few answers first (for example what you did in a job, a project, or your skills), then try again.',
  aiFailed: 'We couldn’t polish your resume right now. You haven’t been charged. Please try again.',
  notCharged: 'Something went wrong on our side. Please check the counter above before trying again.',
  server: 'Server error, please try again.'
};

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const recent = new Map();                                       // idempotency cache: key -> { at, body }
const RECENT_MS = 5 * 60 * 1000;
const cacheKey = (code, id) => crypto.createHash('sha256').update(`${code}:${id}`).digest('hex');
function cacheGet(k) { const v = recent.get(k); if (v && Date.now() - v.at < RECENT_MS) return v.body; recent.delete(k); return null; }
function cachePut(k, body) { recent.set(k, { at: Date.now(), body }); if (recent.size > 200) recent.delete(recent.keys().next().value); }

function buildPrompt(source, target) {
  return `You are a resume-writing assistant helping a first-time or returning job seeker. You will receive the person's OWN answers as structured JSON. Rewrite them into clear, professional, job-relevant resume wording.

Strict rules:
1. Use ONLY facts that appear in the JSON. Never invent or change employers, job titles, dates, schools, degrees, certifications, licenses, awards or locations. Copy those fields exactly as given.
2. Never add numbers, percentages, dollar amounts, team sizes or any other metric that is not already in the answers. Never imply leadership, supervision, or training others unless the answers say so.
3. Reword only: summary.tagline, summary.bullets, summary.skills, and the bullets / description / summary of each entry in experience, projects and volunteer. Start bullets with a strong action verb, keep them short, specific and truthful, one idea per bullet. If a line is already clear, leave it as it is. Do not pad.
4. Do not add any job, project, volunteer entry, school or skill the person did not list. If a section is empty, leave it empty: having no work history is normal. Only write a headline or summary from the goal and skills the person actually gave.
5. ${target ? `The person is looking for: "${target}". Choose wording relevant to that goal, still using only the facts above.` : 'No target job was given, so keep the wording general.'}
6. Keep exactly the same JSON schema and keys as the input. Return ONLY valid JSON, no markdown fences, no commentary.

Resume JSON:
${JSON.stringify(source)}`;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const cfg = get();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('polish-resume: AI key not configured');
    return json(500, { error: MSG.server });
  }

  const parsed = readJsonBody(event, cfg.MAX_BODY_BYTES);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });
  const { code: rawCode, resume, target: rawTarget, requestId } = parsed.body;

  // 1. Every check that can reject the request runs BEFORE any billable AI call.
  const code = normalizeCode(rawCode);
  if (!code) return json(401, { error: MSG.refresh });
  if (!CODE_RE.test(code)) return json(400, { error: MSG.badFormat });
  if (!resume || typeof resume !== 'object' || Array.isArray(resume)) return json(400, { error: 'Malformed request' });
  if (JSON.stringify(resume).length > cfg.RESUME_JSON_MAX_CHARS) return json(413, { error: 'That resume is too long to polish. Please shorten it and try again.' });
  const source = Core.clean(resume);
  if (!Core.hasWritableText(source)) return json(400, { error: MSG.nothing });
  const target = typeof rawTarget === 'string' ? rawTarget.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const rid = typeof requestId === 'string' && REQUEST_ID_RE.test(requestId) ? requestId : null;

  let supabase;
  try { supabase = getSupabaseClient(); } catch (err) {
    console.error('polish-resume: database client unavailable');
    return json(503, { error: MSG.server });
  }

  // A repeat of a polish that already finished returns the same result, uncharged.
  if (rid) {
    const hit = cacheGet(cacheKey(code, rid));
    if (hit) {
      try { if (await license.readLicense(supabase, code)) return json(200, hit); } catch (e) { /* fall through to the normal path */ }
    }
  }

  let reservation;
  try {
    reservation = await license.reserve(supabase, code, cfg);
  } catch (err) {
    const missing = err && (err.code === '42883' || err.code === 'PGRST202');
    console.error(missing
      ? 'polish-resume: reserve_license_use is missing. Apply supabase/migrations/20261020_01_license_reservations.sql BEFORE deploying this code.'
      : 'polish-resume: reservation failed', { reason: safeReason(err) });
    return json(503, { error: MSG.server });
  }

  if (reservation.outcome === 'not_found') return json(403, { error: MSG.notFound });
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
    console.error('polish-resume: unexpected reservation outcome', { outcome: reservation.outcome });
    return json(503, { error: MSG.server });
  }

  // One paid operation at a time per code: only the earliest live reservation proceeds.
  try {
    if (!(await isFirstInFlight(supabase, code, reservation.reservationId))) {
      await license.safeRelease(supabase, reservation.reservationId, false);
      return json(409, { error: MSG.busy, usesRemaining: reservation.remaining, maxUses: reservation.maximum });
    }
  } catch (err) {
    console.error('polish-resume: in-flight check failed', { reason: safeReason(err) });
    await license.safeRelease(supabase, reservation.reservationId, false);
    return json(503, { error: MSG.server });
  }

  // 2. Run the AI. ANY failure releases the reservation and the customer is not charged.
  let polished;
  let unverified = [];
  try {
    const text = await callClaude({ prompt: buildPrompt(source, target), maxTokens: cfg.TAILOR_MAX_TOKENS, timeoutMs: cfg.AI_TIMEOUT_MS });
    const shaped = assertResumeShape(extractJson(text));
    try {
      const checked = integrity.reconcile(source, shaped, { flagNewSummary: true });
      polished = checked.resume; unverified = checked.unverified;
    } catch (e) {
      console.error('polish-resume: integrity check failed', { reason: safeReason(e) });
      polished = shaped;
      unverified = [{ where: 'resume', text: '', reasons: ['Automatic check unavailable: please review every line before using this resume.'] }];
    }
  } catch (err) {
    const providerFault = isProviderFault(err);
    await license.safeRelease(supabase, reservation.reservationId, !providerFault);
    console.error('polish-resume: generation failed', { reservation: reservation.reservationId, reason: (err && err.reason) || 'unexpected', counted: !providerFault });
    return json(502, { error: MSG.aiFailed });
  }

  // 3. Charge only now. Commit is idempotent, so one retry after a transient error is safe.
  let committed;
  for (let attempt = 0; attempt < 2 && !committed; attempt++) {
    try { committed = await license.commit(supabase, reservation.reservationId); }
    catch (err) { console.error('polish-resume: commit attempt failed', { reservation: reservation.reservationId, attempt }); }
  }
  if (!committed) {
    await license.safeRelease(supabase, reservation.reservationId, false);
    return json(503, { error: MSG.notCharged });
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

  const body = { result: JSON.stringify(polished), unverified, usesRemaining: committed.remaining, maxUses: committed.maximum, tailorToken };
  if (rid) cachePut(cacheKey(code, rid), body);
  return json(200, body);
};

exports._recent = recent;     // for tests
