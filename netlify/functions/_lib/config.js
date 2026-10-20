// Tunables for the paid AI endpoints. Read at call time so tests can override env vars.
function int(v, fallback, min = 1) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function get() {
  const aiTimeoutMs = int(process.env.AI_TIMEOUT_MS, 24000, 1000);
  return {
    MODEL: 'claude-sonnet-4-5-20250929',
    // Input limits (characters). A 5-page resume is roughly 15k characters.
    RESUME_MAX_CHARS: 30000,
    JOB_DESC_MAX_CHARS: 10000,
    RESUME_JSON_MAX_CHARS: 60000,
    MAX_BODY_BYTES: 262144,
    // Output caps. The old 2000/3000 caps truncated long resumes into unparseable JSON.
    PARSE_MAX_TOKENS: 4000,
    TAILOR_MAX_TOKENS: 6000,
    AI_TIMEOUT_MS: aiTimeoutMs,
    // A reservation must outlive the AI call, so a request that is still running is never double-booked.
    // If the function dies mid-call the lease simply lapses and the use is never charged.
    LEASE_SECONDS: Math.max(45, Math.ceil(aiTimeoutMs / 1000) + 20),
    // Tailoring authorisation: bound to one paid generation.
    TAILOR_TOKEN_TTL_SECONDS: 2 * 60 * 60,
    TAILOR_MAX_PER_PAID_OP: 5
  };
}

module.exports = { get };
