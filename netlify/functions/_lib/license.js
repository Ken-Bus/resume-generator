// Server-side accounting for paid generations (see supabase/schema.sql, "Reservation-based accounting").
//   reserve -> run the AI -> commit on a validated result, release on failure.
// A crash between reserve and commit just lets the lease expire, so a failure never costs a use.

async function one(supabase, fn, args) {
  const { data, error } = await supabase.rpc(fn, args).maybeSingle();
  if (error) throw error;
  return data;
}

async function reserve(supabase, code, cfg) {
  const d = await one(supabase, 'reserve_license_use', {
    p_code: code,
    p_lease_seconds: cfg.LEASE_SECONDS,
    p_fail_window_seconds: cfg.FAIL_WINDOW_SECONDS,
    p_fail_window_max: cfg.FAIL_WINDOW_MAX,
    p_fail_day_max: cfg.FAIL_DAY_MAX
  });
  if (!d) throw new Error('reserve_license_use returned no row');
  return { outcome: d.outcome, reservationId: d.reservation_id, remaining: d.remaining, maximum: d.maximum, retryAfterSeconds: d.retry_after_seconds };
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

module.exports = { reserve, commit, safeRelease, tailorAuthorize, safeTailorRefund, readLicense };
