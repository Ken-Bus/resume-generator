// Server-side accounting for paid generations (see supabase/schema.sql, "Reservation-based accounting").
//   reserve -> run the AI -> commit on a validated result, release on failure.
// A crash between reserve and commit just lets the lease expire, so a failure never costs a use.

async function one(supabase, fn, args) {
  const { data, error } = await supabase.rpc(fn, args).maybeSingle();
  if (error) throw error;
  return data;
}

// `repeat` (optional) = { key, inputHash }: identifies one logical step so the DATABASE can recognise a repeat of an already-paid step
// (migration 03). Without it the call is exactly the one the earlier deployment made.
async function reserve(supabase, code, cfg, repeat) {
  const d = await one(supabase, 'reserve_license_use', {
    ...(repeat && repeat.key ? { p_request_key: repeat.key, p_input_hash: repeat.inputHash || null } : {}),
    p_code: code,
    p_lease_seconds: cfg.LEASE_SECONDS,
    p_fail_window_seconds: cfg.FAIL_WINDOW_SECONDS,
    p_fail_window_max: cfg.FAIL_WINDOW_MAX,
    p_fail_day_max: cfg.FAIL_DAY_MAX
  });
  if (!d) throw new Error('reserve_license_use returned no row');
  return { outcome: d.outcome, reservationId: d.reservation_id, remaining: d.remaining, maximum: d.maximum, retryAfterSeconds: d.retry_after_seconds };
}

// Gives the re-delivery turn back (ok = false) or just frees the slot (ok = true). Best effort: the turn also lapses by itself after a minute.
async function finishRedelivery(supabase, reservationId, ok) {
  try {
    const { error } = await supabase.rpc('finish_redelivery', { p_reservation_id: reservationId, p_ok: !!ok });
    if (error) throw error;
  } catch (e) { console.error('finish_redelivery failed; the turn lapses on its own', { reservation: reservationId }); }
}

// Commit the generation AND store the encrypted recovery copy in ONE database transaction (migration 04). `sealed` = vault.seal(...).
// If either part fails nothing is charged. result.saved is true only when a copy exists for this step.
async function commitWithResult(supabase, reservationId, fn, sealed) {
  const d = await one(supabase, 'commit_license_use_with_result', {
    p_reservation_id: reservationId, p_fn: fn, p_kid: sealed.kid, p_salt: sealed.salt, p_iv: sealed.iv, p_ct: sealed.ct
  });
  if (!d) throw new Error('commit_license_use_with_result returned no row');
  return { outcome: d.outcome, remaining: d.remaining, maximum: d.maximum, saved: d.result_saved === true, expiresAt: d.expires_at };
}

// What this code could restore (no content), and the encrypted copy of one step. Both only ever see this code's own rows and never expired ones.
async function listRecoverable(supabase, code) {
  const { data, error } = await supabase.rpc('list_recoverable_results', { p_code: code });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}
async function fetchRecoverable(supabase, code, id) {
  const d = await one(supabase, 'fetch_recoverable_result', { p_code: code, p_id: id });
  return d || null;
}
// Is migration 04 applied? Asked before any paid step so that a deployment without it refuses BEFORE the AI is called (no cost, no charge).
// A positive answer is remembered for the life of the instance; a negative one is asked again next time.
let recoverySchemaOk = false;
async function recoveryReady(supabase) {
  if (recoverySchemaOk) return true;
  const { error } = await supabase.rpc('list_recoverable_results', { p_code: 'FG-PROBE-0000' });
  if (error) { if (error.code === '42883' || error.code === 'PGRST202' || error.code === '42P01') return false; throw error; }
  recoverySchemaOk = true; return true;
}
async function purgeRecoverable(supabase) {
  const { data, error } = await supabase.rpc('purge_recoverable_results', {});
  if (error) throw error;
  return Number(data) || 0;
}

async function commit(supabase, reservationId) {
  const d = await one(supabase, 'commit_license_use', { p_reservation_id: reservationId });
  if (!d) throw new Error('commit_license_use returned no row');
  return { outcome: d.outcome, remaining: d.remaining, maximum: d.maximum };
}

// Idempotent and best-effort: if this fails the lease expires on its own.
// counted = false for provider outages, which never count toward the per-code failure budget.
// One retry: a lapsed lease is counted as a costly failure, so a brief database hiccup during the release should not become a strike
// against a customer who did nothing wrong. If both attempts fail the lease still expires on its own and nothing is charged.
async function safeRelease(supabase, reservationId, counted = true) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await supabase.rpc('release_license_use', { p_reservation_id: reservationId, p_counted: counted });
      if (error) throw error;
      return;
    } catch (e) {
      if (attempt === 1) console.error('release_license_use failed; the lease will expire on its own', { reservation: reservationId });
    }
  }
}

async function tailorAuthorize(supabase, reservationId, max) {
  const d = await one(supabase, 'consume_tailor_use', { p_reservation_id: reservationId, p_max: max });
  if (!d) throw new Error('consume_tailor_use returned no row');
  return { outcome: d.outcome, used: d.used };
}

// A provider outage is always given back; other failures only up to forgiveMax per paid generation.
async function safeTailorRefund(supabase, reservationId, providerFault, forgiveMax) {
  try {
    const { error } = await supabase.rpc('refund_tailor_use', {
      p_reservation_id: reservationId, p_provider_fault: !!providerFault, p_forgive_max: forgiveMax
    });
    if (error) throw error;
  } catch (e) {
    console.error('refund_tailor_use failed', { reservation: reservationId });
  }
}

async function readLicense(supabase, code) {
  const { data, error } = await supabase.from('licenses').select('uses_remaining, max_uses').eq('code', code).maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = { reserve, finishRedelivery, commitWithResult, listRecoverable, fetchRecoverable, purgeRecoverable, recoveryReady, commit, safeRelease, tailorAuthorize, safeTailorRefund, readLicense };
