const { getSupabaseClient, json } = require('./_lib/supabase');
const { sendLowSupplyAlert } = require('./_lib/alert');
const { generateAndInsertCodes } = require('../../lib/codes');

// Scheduled daily (see netlify.toml). Keeps the unassigned code pool
// topped up so the Google Apps Script delivery never runs out of codes.
const THRESHOLD = parseInt(process.env.CODE_SUPPLY_THRESHOLD || '20', 10);
const BATCH_SIZE = parseInt(process.env.CODE_SUPPLY_BATCH_SIZE || '100', 10);

exports.handler = async function() {
  try {
    const supabase = getSupabaseClient();
    const { count, error: countError } = await supabase
      .from('licenses')
      .select('code', { count: 'exact', head: true })
      .eq('assigned', false);

    if (countError) throw countError;

    const remaining = count || 0;

    if (remaining >= THRESHOLD) {
      console.log(`check-code-supply: ${remaining} unassigned codes remaining (threshold ${THRESHOLD}). No action taken.`);
      return json(200, { ok: true });          // counts stay in the log: the response is public if the function can be called as a URL
    }

    console.log(`check-code-supply: ${remaining} unassigned codes remaining, below threshold (${THRESHOLD}). Generating ${BATCH_SIZE} more.`);
    const inserted = await generateAndInsertCodes(supabase, BATCH_SIZE);
    const newRemaining = remaining + inserted.length;
    console.log(`check-code-supply: generated ${inserted.length} new codes. Remaining unassigned: ${newRemaining}.`);

    if (remaining === 0) {
      // Replenishment should prevent this, but flag it so Ken knows the
      // pool actually ran dry before this run topped it back up.
      await sendLowSupplyAlert({
        reason: 'zero_supply_detected_by_scheduled_check',
        remainingBeforeReplenish: remaining,
        generated: inserted.length
      });
    }

    return json(200, { ok: true });
  } catch (err) {
    console.error('check-code-supply failed:', err);
    return json(500, { error: 'check-code-supply failed' });
  }
};
