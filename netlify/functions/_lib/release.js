// Which generation of the factual-integrity layer this deploy runs. Public on purpose: it is a version label, nothing else, and
// opening an AI function's address in a browser (a GET, which never reaches billing, a licence or the AI) shows it.
const Core = require('../../../resume-core.js');

const stamp = () => ({ version: Core.GUARD_VERSION, withholds: true, deploy: String(process.env.DEPLOY_ID || process.env.COMMIT_REF || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || null });

// Answer to any non-POST request. Still a 405 (nothing is served), but readable and carrying the stamp.
const notAllowed = () => ({
  statusCode: 405,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Allow: 'POST' },
  body: JSON.stringify({ error: 'Method Not Allowed', guard: stamp() })
});

// A page that was loaded before a deploy still carries the old rules. It says which version it is (`clientGuard`); a different
// version is refused BEFORE any reservation or AI call, so nothing is charged. A request without the field is not refused.
const staleClient = (clientGuard) => typeof clientGuard === 'string' && clientGuard !== Core.GUARD_VERSION;
const STALE_MESSAGE = 'This page is out of date. Please refresh it (reload the page) and try again. You haven’t been charged.';

module.exports = { stamp, notAllowed, staleClient, STALE_MESSAGE };
