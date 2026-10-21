// One paid operation at a time per license code (used by polish-resume).
// After reserving, a request checks whether an EARLIER live reservation exists for the same code. Reservations
// are totally ordered by (created_at, id), so when two requests race, exactly one is first and proceeds; the
// other releases its reservation uncharged and tells the customer to wait. This turns a double-click or a
// retry-while-running into a harmless rejection instead of a second charge, with no schema change.
async function isFirstInFlight(supabase, code, reservationId, nowIso = new Date().toISOString()) {
  const { data, error } = await supabase
    .from('license_reservations')
    .select('id, created_at')
    .eq('code', code)
    .eq('status', 'reserved')
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1);
  if (error) throw error;
  return !data || data.length === 0 || data[0].id === reservationId;
}

module.exports = { isFirstInFlight };
