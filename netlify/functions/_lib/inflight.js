// One paid operation at a time per license code (used by polish-resume).
// After reserving, a request looks at the other live reservations for the same code. This turns a double-click or a retry-while-running
// into a harmless rejection instead of a second charge, with no schema change.
//
// Why not simply "am I the earliest?": a reservation's created_at is the START time of the database transaction that inserted it, which
// can be earlier than another request's even though it was inserted (and checked) later, because the reserve function waits on a row lock.
// Then the later arrival checked first, saw only itself and started the AI; the earlier-stamped one then also believed it was first.
// So:  nobody else live -> go.  Others live and I am not the earliest -> yield.  Others live and I am the earliest -> they may be yielding
// (a double-click: wait a moment and look again) or already running (the race above): go only if they are gone, otherwise yield.
// At most one request ever proceeds; in the worst case a very close pair both yield and the customer simply tries again.
const SETTLE_MS = 150;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function liveReservations(supabase, code, nowIso) {
  const { data, error } = await supabase
    .from('license_reservations')
    .select('id, created_at')
    .eq('code', code)
    .eq('status', 'reserved')
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(10);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function isFirstInFlight(supabase, code, reservationId, nowIso = new Date().toISOString(), settleMs = SETTLE_MS) {
  const live = await liveReservations(supabase, code, nowIso);
  const others = live.filter((r) => r.id !== reservationId);
  if (!others.length) return true;
  if (live[0].id !== reservationId) return false;                           // somebody is ahead of me
  await pause(settleMs);                                                    // I am the earliest: are the others on their way out?
  const again = (await liveReservations(supabase, code, new Date().toISOString())).filter((r) => r.id !== reservationId);
  return again.length === 0;
}

module.exports = { isFirstInFlight, SETTLE_MS };
