// What the customer is told, and what the server does, when a request id that was already used comes back (migration 03).
// The principle: a RETRY can never become a second charge. Only a new request id (a deliberate new operation) can.
//   request_conflict : the id was used for a different resume. Refused, nothing charged, the page must use a new id.
//   request_expired  : the id is older than the 24-hour recovery window. Refused, nothing charged, the page must use a new id.
//   recovery_limit   : the paid step was re-delivered the maximum number of times. Nothing charged; a support reference is shown.
// Every refusal carries a non-secret support reference (the first 8 characters of the paid step's id). It identifies a step for the owner and
// grants nothing: it is not the access code and cannot be used to spend, read or recover anything.
const reference = (id) => (typeof id === 'string' && id ? `R-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}` : null);

const WHAT = { analyze: 'analysis', polish: 'polish' };
const refLine = (ref) => (ref ? ` If a generation looks wrong, message us with this reference: ${ref} (never your access code or your resume).` : '');

function blocked(reservation, fn) {
  const what = WHAT[fn] || 'step';
  const ref = reference(reservation && reservation.reservationId);
  const base = { usesRemaining: reservation.remaining, maxUses: reservation.maximum, supportRef: ref };
  switch (reservation.outcome) {
    case 'key_conflict':
      return { status: 409, body: { ...base, code: 'request_conflict', newRequest: true,
        error: `Your resume has changed since an earlier ${what} that may already have been completed and counted. Nothing was charged just now and your resume is unchanged. Please check the generations counter, then press the button again to start a new ${what} of your current resume.${refLine(ref)}` } };
    case 'key_expired':
      return { status: 409, body: { ...base, code: 'request_expired', newRequest: true,
        error: `That earlier ${what} is more than a day old, so its result can no longer be recovered here. Nothing was charged just now. Please check the generations counter, then press the button again to start a new ${what}.${refLine(ref)}` } };
    case 'replay_limit':
      return { status: 409, body: { ...base, code: 'recovery_limit', newRequest: true,
        error: `Your earlier ${what} was completed and counted, but its result did not reach you after several tries. Nothing more has been charged and your resume is unchanged. Please message us with this reference: ${ref} (never your access code or your resume) and we will put it right. You can also press the button again to start a new ${what}.` } };
    default: return null;
  }
}

// The re-delivery itself could not be produced (provider outage, timeout, unusable answer). Its turn is given back; nothing more is charged.
function failed(reservation, fn, busy) {
  const what = WHAT[fn] || 'step';
  const ref = reference(reservation && reservation.reservationId);
  return { code: 'recovery_failed', supportRef: ref, usesRemaining: reservation.remaining, maxUses: reservation.maximum,
    error: busy
      ? `Your earlier ${what} was completed and counted, and nothing more has been charged. The AI service is very busy right now, so we could not prepare its result. Please wait a minute or two and try again. Your resume is unchanged.`
      : `Your earlier ${what} was completed and counted, and nothing more has been charged. We could not prepare its result just now. Please wait a moment and try again. Your resume is unchanged.` };
}

// Honest labels for a recovered result. We do NOT store AI output, so a recovery on another server is a NEW answer for the same resume.
const RECOVERED = {
  exact: 'Your earlier result has been restored exactly as it was. No additional generation was used.',
  regenerated: 'Your earlier step was completed and counted, but its result did not reach you. We prepared a fresh version for the same resume, so the wording may differ from the first one. No additional generation was used.'
};

// ── the stored, exact copy (migration 04) ────────────────────────────────────────────────────────────────────────────
const vault = require('./vault');
const tokens = require('./token');
const license = require('./license');

// The response a customer gets when a completed step is restored. A new Tailor authorization is signed for the SAME paid generation: it adds no
// Tailor runs (the allowance is counted in the database against that generation), it only lets the page use the ones that remain.
// A restored INCLUDED Polish (payload.included, migration 05) is signed for its PARENT Analyze, so restoring it adds no Tailor runs and does not lose the
// ones the customer still has; it is not a charged step (charged: false, included: true).
function restoredBody(fn, payload, row, { secret, ttl, guard }) {
  const included = fn === 'polish' && payload.included === true && typeof payload.parent === 'string';
  const tailorToken = tokens.isUsable(secret) ? tokens.sign(secret, included ? payload.parent : row.id, ttl) : null;
  const common = { result: payload.result, unverified: Array.isArray(payload.unverified) ? payload.unverified : [], usesRemaining: row.remaining, maxUses: row.maximum, tailorToken,
    recovered: 'exact', message: RECOVERED.exact, supportRef: reference(row.id), saved: true, kind: fn, savedAt: row.created_at, expiresAt: row.expires_at };
  return fn === 'polish'
    ? { guard, ...common, withheld: Array.isArray(payload.withheld) ? payload.withheld : [], changes: payload.changes || null, points: payload.points, threshold: payload.threshold, charged: !included, ...(included ? { included: true } : {}) }
    : common;
}

// -> the restored response for THIS code's step, or null (no copy, expired, other code's step, wrong kind, cannot be opened). Never throws; logs no content.
async function exactFor({ supabase, code, stepId, fn, secret, ttl, guard }) {
  let row;
  try { row = await license.fetchRecoverable(supabase, code, stepId); } catch (e) { return null; }
  if (!row || (fn && row.fn !== fn)) return null;                       // fn = null means "whatever kind this step was" (the restore endpoint)
  let payload;
  try { payload = JSON.parse(vault.open(row, { recordId: row.id, fn: row.fn })); } catch (e) { console.error('recovery: a stored copy could not be opened', { ref: 'R301' }); return null; }
  return restoredBody(row.fn, payload, row, { secret, ttl, guard });
}

module.exports = { reference, blocked, failed, RECOVERED, restoredBody, exactFor };
