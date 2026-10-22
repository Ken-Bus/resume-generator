const crypto = require('crypto');
const { getSupabaseClient, CODE_RE, normalizeCode, json } = require('./_lib/supabase');
const { get } = require('./_lib/config');
const { readJsonBody } = require('./_lib/http');
const license = require('./_lib/license');
const { makeLimiter, clientIp } = require('./_lib/rate');
const Core = require('../../resume-core.js');
const Templates = require('../../templates.js');
const render = require('./_lib/export-render');

// Licensed PDF/Word download. This is an AUTHORIZATION check, not a paid generation: it never reserves,
// commits or releases a use, and it never calls the AI. The files are produced here, on the server, after the
// license is verified, and the browser holds no PDF/Word rendering code, so there is no client-side route to a
// customer download. A valid code that has used all its generations can still download (the code is the purchase).
//
// Security model
//   authorization : the license code must exist in the licenses table, checked in the database on EVERY request.
//   replay/expiry : nothing to replay. There is no bearer token, the call has no side effects, and entitlement is
//                   re-read from the database each time (a revoked/deleted code stops working immediately).
//   brute force   : bad codes count against a per-client limit (best-effort, in memory; see _lib/rate.js);
//                   good codes are limited per code so a leaked code cannot be used to scrape the renderer.
//   CORS          : same-origin only. No Access-Control-* header is ever sent.
//   privacy       : codes and resume text are never logged; error messages never echo input.

// Error messages from the database can echo query values (such as the license code), so only a code or name is logged.
const safeReason = (e) => String((e && (e.code || e.name)) || 'error').slice(0, 40);

// References for support (same idea as polish-resume): E101 license lookup failed, E102 file could not be rendered.
const MSG = {
  refresh: 'Please refresh the page and enter your access code again.',
  badFormat: 'That code doesn’t look right. Check the format: FG-XXXX-XXXX.',
  notFound: 'We couldn’t find that code.',
  empty: 'Add some details to your resume before downloading.',
  tooBig: 'That resume is too large to download. Please shorten it and try again.',
  slow: 'Too many attempts in a short time. Please wait a moment and try again.',
  server: 'We couldn’t prepare your download. Please try again.'
};

const FORMATS = { pdf: { type: 'application/pdf', ext: 'pdf' }, docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' } };
const failedLookups = makeLimiter({ windowMs: 10 * 60 * 1000, max: 20 });   // per client
const perCode = makeLimiter({ windowMs: 10 * 60 * 1000, max: 60 });          // per license code
const codeKey = (code) => crypto.createHash('sha256').update(code).digest('hex').slice(0, 24);

const reply = (statusCode, error, extra) => json(statusCode, { error }, { 'X-Content-Type-Options': 'nosniff', ...(extra || {}) });

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' }, body: 'Method Not Allowed' };
  }
  const cfg = get();
  const ip = clientIp(event);

  const blocked = failedLookups.wait(ip);
  if (blocked) return reply(429, MSG.slow, { 'Retry-After': String(blocked) });

  const parsed = readJsonBody(event, cfg.MAX_BODY_BYTES);
  if (!parsed.ok) return reply(parsed.status, parsed.error);
  const { code: rawCode, format, template: templateId, alt, resume } = parsed.body;

  // 1. Cheap checks first.
  const code = normalizeCode(rawCode);
  if (!code) return reply(401, MSG.refresh);
  if (!CODE_RE.test(code)) { failedLookups.hit(ip); return reply(400, MSG.badFormat); }

  // 2. Authorization: the license must exist, verified in the database on every request.
  let row;
  try {
    row = await license.readLicense(getSupabaseClient(), code);
  } catch (err) {
    console.error('export-resume: license lookup failed', { ref: 'E101', reason: safeReason(err) });
    return reply(503, `${MSG.server} (ref E101)`);
  }
  if (!row) { failedLookups.hit(ip); return reply(403, MSG.notFound); }
  const key = codeKey(code);
  const wait = perCode.wait(key);
  if (wait) return reply(429, MSG.slow, { 'Retry-After': String(wait) });

  // 3. Validate what is being rendered.
  const fmt = typeof format === 'string' && Object.prototype.hasOwnProperty.call(FORMATS, format) ? FORMATS[format] : null;
  const template = typeof templateId === 'string' ? Templates.byId(templateId) : null;
  if (!fmt || !template) return reply(400, 'Malformed request');
  if (!resume || typeof resume !== 'object' || Array.isArray(resume)) return reply(400, 'Malformed request');
  if (JSON.stringify(resume).length > cfg.RESUME_JSON_MAX_CHARS) return reply(413, MSG.tooBig);
  if (!Core.hasContent(resume)) return reply(400, MSG.empty);

  // 4. Render and return the file.
  let out;
  try {
    perCode.hit(key);
    out = format === 'pdf' ? render.renderPDF(resume, template, alt === true) : await render.renderWord(resume, template, alt === true);
  } catch (err) {
    console.error('export-resume: render failed', { ref: 'E102', format, template: template.id, reason: safeReason(err) });
    return reply(500, `${MSG.server} (ref E102)`);
  }
  const ascii = out.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      'Content-Type': fmt.type,
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(out.simplified ? { 'X-Export-Notice': 'simplified' } : {})
    },
    body: Buffer.from(out.buffer).toString('base64')
  };
};

exports._limiters = { failedLookups, perCode };     // for tests
