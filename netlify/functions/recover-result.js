// Restore a COMPLETED, already-charged Analyze or AI Polish result that never reached the customer (power cut, closed browser, lost connection).
//   POST { code, action: "list" }         -> what could be restored right now (kind, saved time, expiry). No resume content.
//   POST { code, action: "fetch", id }    -> the exact stored result, decrypted, plus a Tailor authorization for the SAME paid generation.
// Safe by construction:
//   * Costs nothing: no generation, no Tailor run, no AI call. It only reads.
//   * The access code is the only credential (the customer's own purchase code); an id from another code, an unknown id, an expired copy and a
//     copy that cannot be opened all answer the SAME generic 404, so nothing is learned about other customers.
//   * Guessing is limited per client (codes and ids), like the other endpoints. Bad input is rejected before the database is touched.
//   * Nothing is deleted by reading; a copy expires on its own 24 hours after it was written (enforced by the database on every read) and is purged hourly.
//   * No resume text, code, id or key is ever logged.
const release = require('./_lib/release');
const { getSupabaseClient, CODE_RE, normalizeCode, json } = require('./_lib/supabase');
const { get } = require('./_lib/config');
const { readJsonBody } = require('./_lib/http');
const license = require('./_lib/license');
const recovery = require('./_lib/recovery');
const vault = require('./_lib/vault');
const { makeLimiter, clientIp } = require('./_lib/rate');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failures = makeLimiter({ windowMs: 10 * 60 * 1000, max: 30 });          // unknown codes and unknown ids count against the client
const lookups = makeLimiter({ windowMs: 60 * 1000, max: 30 });               // every call counts, so this endpoint cannot be used to hammer the database
const safeReason = (e) => String((e && (e.code || e.name)) || 'error').slice(0, 40);
const MSG = {
  refresh: 'Please refresh the page and enter your access code again.',
  badFormat: 'That code doesn’t look right. Check the format: FG-XXXX-XXXX.',
  none: 'We couldn’t find a saved result to restore. Results are kept for up to 24 hours after they finish. If a generation was used and nothing is saved, please message us with the reference shown on your screen (never your access code or your resume).',
  wait: 'Too many attempts in a short time. Please wait a moment and try again.',
  server: 'We couldn’t check for a saved result just now. Nothing has been used. Please try again in a moment.'
};

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return release.notAllowed();
  const cfg = get();
  const parsed = readJsonBody(event, 4096);                                      // the request is tiny: a code and an id
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });
  const { code: rawCode, action, id } = parsed.body;

  const code = normalizeCode(rawCode);
  if (!code) return json(401, { error: MSG.refresh });
  const ip = clientIp(event);
  const blocked = Math.max(failures.wait(ip), lookups.wait(ip));
  if (blocked) return json(429, { error: MSG.wait }, { 'Retry-After': String(blocked) });
  lookups.hit(ip);
  if (!CODE_RE.test(code)) { failures.hit(ip); return json(400, { error: MSG.badFormat }); }
  if (action !== 'list' && action !== 'fetch') return json(400, { error: 'Malformed request' });
  if (action === 'fetch' && !(typeof id === 'string' && UUID_RE.test(id))) { failures.hit(ip); return json(404, { error: MSG.none }); }
  if (!vault.ready()) { console.error('recover-result: RESULT_ENCRYPTION_KEY is not configured', { ref: 'R310' }); return json(503, { error: MSG.server }); }

  let supabase;
  try {
    supabase = getSupabaseClient();
    const lic = await license.readLicense(supabase, code);
    if (!lic) { failures.hit(ip); return json(action === 'list' ? 200 : 404, action === 'list' ? { results: [] } : { error: MSG.none }); }   // an unknown code looks exactly like "nothing saved"

    if (action === 'list') {
      const rows = await license.listRecoverable(supabase, code);
      return json(200, { results: rows.map((r) => ({ id: r.id, kind: r.fn, savedAt: r.created_at, expiresAt: r.expires_at })), usesRemaining: lic.uses_remaining, maxUses: lic.max_uses });
    }
    const body = await recovery.exactFor({ supabase, code, stepId: id.toLowerCase(), fn: null, secret: process.env.TAILOR_TOKEN_SECRET, ttl: cfg.TAILOR_TOKEN_TTL_SECONDS, guard: release.stamp() });
    if (!body) { failures.hit(ip); return json(404, { error: MSG.none }); }
    return json(200, body);
  } catch (err) {
    console.error('recover-result: lookup failed', { reason: safeReason(err) });
    return json(503, { error: MSG.server });
  }
};

