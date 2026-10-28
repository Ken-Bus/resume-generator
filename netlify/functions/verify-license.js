const { getSupabaseClient, CODE_RE, normalizeCode, json } = require('./_lib/supabase');
const { makeLimiter, clientIp } = require('./_lib/rate');
const license = require('./_lib/license');
const { get } = require('./_lib/config');

// Guessing codes: unknown or malformed codes are limited per client (best effort, in memory; see _lib/rate.js). A real customer who
// mistypes a code a few times is never affected.
const failedChecks = makeLimiter({ windowMs: 10 * 60 * 1000, max: 30 });

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const ip = clientIp(event);
  const blocked = failedChecks.wait(ip);
  if (blocked) return json(429, { valid: false, error: 'Too many attempts in a short time. Please wait a moment and try again.' }, { 'Retry-After': String(blocked) });

  let code;
  try {
    ({ code } = JSON.parse(event.body));
  } catch (e) {
    return json(400, { valid: false, error: 'Malformed request' });
  }

  code = normalizeCode(code);
  if (!CODE_RE.test(code)) {
    failedChecks.hit(ip);
    return json(200, { valid: false, error: 'That code doesn’t look right. Check the format: FG-XXXX-XXXX.' });
  }

  try {
    const supabase = getSupabaseClient();

    // Migration 05: a code with no generations left can still sign in to finish and download (an unused included Polish, or the four-day completion
    // period), and tells the page which of those applies. null = migration 05 is not applied: keep the earlier behaviour below.
    const access = await license.accessStatus(supabase, code);
    if (access) {
      if (access.state === 'not_found') { failedChecks.hit(ip); return json(200, { valid: false, error: 'We couldn’t find that code.' }); }
      if (access.state === 'ended') {
        return json(200, { valid: false, accessState: 'ended', error: 'The four-day finishing period for this code has ended, and it has no AI generations left.', usesRemaining: access.usesRemaining, maxUses: access.maxUses });
      }
      // Tailor runs the code has left (migration 06). Best effort: signing in never fails because of it, and the field is simply absent without it.
      let tailorRunsAvailable;
      try { const n = await license.tailorRunsAvailable(supabase, code, get().TAILOR_MAX_PER_PAID_OP); if (n !== null) tailorRunsAvailable = n; } catch (e) { /* not needed to sign in */ }
      return json(200, { valid: true, usesRemaining: access.usesRemaining, maxUses: access.maxUses, includedAvailable: access.includedAvailable, accessState: access.state, accessUntil: access.accessUntil, ...(tailorRunsAvailable !== undefined ? { tailorRunsAvailable } : {}) });
    }

    const { data, error } = await supabase
      .from('licenses')
      .select('uses_remaining, max_uses')
      .eq('code', code)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      failedChecks.hit(ip);
      return json(200, { valid: false, error: 'We couldn’t find that code.' });
    }

    if (data.uses_remaining <= 0) {
      return json(200, {
        valid: false,
        error: 'This code has no generations remaining.',
        usesRemaining: 0,
        maxUses: data.max_uses
      });
    }

    return json(200, { valid: true, usesRemaining: data.uses_remaining, maxUses: data.max_uses });
  } catch (err) {
    return json(500, { valid: false, error: 'Server error, please try again.' });
  }
};

exports._failedChecks = failedChecks;     // for tests
