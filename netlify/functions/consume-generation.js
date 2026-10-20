const { getSupabaseClient, CODE_RE, normalizeCode, json } = require('./_lib/supabase');
const license = require('./_lib/license');

// DEPRECATED SHIM — scheduled for removal ~72 hours after the reservation-based release.
//
// Generations are now charged server-side inside parse-resume, only after a validated AI result.
// This endpoint used to decrement a use up front. It stays only so a browser tab that was opened
// BEFORE the deploy cannot be charged for a call that the new parse-resume then rejects. It reads
// the license and reports the counts. It never writes.
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let code;
  try {
    ({ code } = JSON.parse(event.body));
  } catch (e) {
    return json(400, { success: false, error: 'Malformed request' });
  }

  code = normalizeCode(code);
  if (!CODE_RE.test(code)) {
    return json(200, { success: false, error: 'That code doesn’t look right. Check the format: FG-XXXX-XXXX.' });
  }

  try {
    const data = await license.readLicense(getSupabaseClient(), code);
    if (!data) return json(200, { success: false, error: 'We couldn’t find that code.' });
    if (data.uses_remaining <= 0) {
      return json(200, { success: false, error: 'You’ve used all generations on this code.', usesRemaining: 0, maxUses: data.max_uses });
    }
    return json(200, { success: true, usesRemaining: data.uses_remaining, maxUses: data.max_uses });
  } catch (err) {
    return json(500, { success: false, error: 'Server error, please try again.' });
  }
};
