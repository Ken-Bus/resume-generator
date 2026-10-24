// Hourly cleanup of expired recovery copies (see netlify.toml). Expired copies are already unreadable (the database refuses to return them); this removes the rows.
// Best effort: if it fails or is late, no expired copy can be returned anyway. The response reveals nothing.
const { getSupabaseClient, json } = require('./_lib/supabase');
const license = require('./_lib/license');

exports.handler = async function () {
  try {
    const n = await license.purgeRecoverable(getSupabaseClient());
    console.log(`purge-recovery: removed ${n} expired recovery ${n === 1 ? 'copy' : 'copies'}.`);
    return json(200, { ok: true });
  } catch (err) {
    console.error('purge-recovery failed', { reason: String((err && (err.code || err.name)) || 'error').slice(0, 40) });
    return json(500, { error: 'purge-recovery failed' });
  }
};
