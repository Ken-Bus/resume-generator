// Tunables for the paid AI endpoints. Read at call time so tests can override env vars.
function int(v, fallback, min = 1) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function get() {
  // Netlify documents 60 s for synchronous functions; 50 s leaves ~10 s for start-up, database calls and the response.
  // Set AI_TIMEOUT_MS explicitly in Netlify as well (runbook §2.3); this fallback only protects against it being forgotten.
  const aiTimeoutMs = int(process.env.AI_TIMEOUT_MS, 50000, 1000);
  return {
    // Sonnet 4.5 is deprecated and retires November 30, 2026; Anthropic's named replacement is Sonnet 5.5.
    MODEL: 'claude-sonnet-5-5',
    // Sonnet 5.5 thinks before answering unless told otherwise, and thinking tokens are billed as output and count toward
    // max_tokens. These are plain rewrite/extract jobs with no tools, so use the documented lowest setting (no up-front
    // thinking; the reply is text only). 'disabled' is rejected by this model with a 400.
    THINKING: { type: 'between_tools' },
    // USD per million tokens for MODEL, used ONLY for the cost estimate written to the usage log (never for charging).
    // Source: Anthropic pricing page, Oct 2026. Update together with MODEL.
    PRICE_PER_MTOK: { input: 2, output: 10 },
    // Input limits (characters). A 5-page resume is roughly 15k characters.
    RESUME_MAX_CHARS: 30000,
    JOB_DESC_MAX_CHARS: 10000,
    RESUME_JSON_MAX_CHARS: 60000,
    MAX_BODY_BYTES: 262144,
    // Output caps. The old 2000/3000 caps truncated long resumes into unparseable JSON.
    // Sonnet 5.5's tokenizer produces about 30% more tokens for the same text, so the caps are raised by the same factor
    // (was 4000 / 6000) to keep long resumes working instead of truncating. Worst-case spend per call stays about the same.
    PARSE_MAX_TOKENS: 5200,
    TAILOR_MAX_TOKENS: 8000,
    AI_TIMEOUT_MS: aiTimeoutMs,
    // A reservation must outlive the AI call, so a request that is still running is never double-booked.
    // If the function dies mid-call the lease simply lapses and the use is never charged.
    LEASE_SECONDS: Math.max(45, Math.ceil(aiTimeoutMs / 1000) + 20),
    // Tailoring authorisation: bound to one paid generation.
    TAILOR_TOKEN_TTL_SECONDS: 2 * 60 * 60,
    TAILOR_MAX_PER_PAID_OP: 5,
    // Bounded failure protection (enforced in the database, under the license row lock).
    // Failures are free to the customer, so costly ones (the AI ran but gave nothing usable) are budgeted per code.
    // Provider outages (HTTP errors, network failures) are never counted.
    FAIL_WINDOW_SECONDS: 15 * 60,
    FAIL_WINDOW_MAX: 6,
    FAIL_DAY_MAX: 30,
    // Costly tailoring failures given back per paid generation; further ones stay used.
    TAILOR_FORGIVEN_FAILURES: 2,
    // AI Polish that finds nothing meaningful to improve is released uncharged AND uncounted above, so it has its own cap
    // (see _lib/nochange.js): per code, per instance.
    NOCHANGE_WINDOW_SECONDS: 15 * 60,
    NOCHANGE_WINDOW_MAX: 3,
    NOCHANGE_DAY_MAX: 10
  };
}

module.exports = { get };
