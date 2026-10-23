// Privacy-safe AI usage log: one line per provider call so real processing cost can be measured instead of estimated.
//
// WHAT IS LOGGED: which paid feature (analyze / polish / tailor), the model, token counts reported by the provider, the stop
// reason, how long the call took, an estimated cost in USD, and the random reservation id (so a line can be matched to the
// "released / not charged / P201" lines in the same log).
// WHAT IS NEVER LOGGED: resume text, job descriptions, prompts, replies, names, emails, license codes, API keys.
// Every value is a number, a short enum-like string or a UUID, and anything else is dropped, so a caller cannot leak text
// into the log by accident. Logging can never fail or slow a request.
const FNS = new Set(['analyze', 'polish', 'tailor']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORD_RE = /^[a-z0-9_.-]{1,40}$/i;

const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const word = (v) => (typeof v === 'string' && WORD_RE.test(v) ? v : null);

// Estimated USD for one call. Cache tokens are not used by this app; if the provider ever reports them they are priced
// as ordinary input so the estimate errs high.
function estimateUsd(u, price) {
  if (!u || !price) return null;
  const inTok = (u.input || 0) + (u.cacheWrite || 0) + (u.cacheRead || 0);
  return Math.round(((inTok * price.input + (u.output || 0) * price.output) / 1e6) * 1e6) / 1e6;
}

// provider = the parsed JSON body of the Anthropic response (or null when there is none, e.g. a timeout).
function record({ fn, model, provider, ms, ref, aborted, price }) {
  try {
    const u = provider && provider.usage && typeof provider.usage === 'object' ? provider.usage : null;
    const tokens = u ? { input: count(u.input_tokens), output: count(u.output_tokens), cacheWrite: count(u.cache_creation_input_tokens), cacheRead: count(u.cache_read_input_tokens) } : null;
    const line = {
      fn: FNS.has(fn) ? fn : 'unknown',
      model: word(model),
      in: tokens ? tokens.input : null,
      out: tokens ? tokens.output : null,
      ...(tokens && (tokens.cacheWrite || tokens.cacheRead) ? { cacheWrite: tokens.cacheWrite, cacheRead: tokens.cacheRead } : {}),
      stop: aborted ? 'timeout' : word(provider && provider.stop_reason),
      usd: tokens ? estimateUsd(tokens, price) : null,
      ms: count(ms),
      ref: typeof ref === 'string' && UUID_RE.test(ref) ? ref : null
    };
    console.log(`ai-usage ${JSON.stringify(line)}`);
    return line;
  } catch (e) {
    return null;
  }
}

// One line per paid attempt saying how it ended, so cost can be split into charged / released-as-no-change / withheld / failed.
// Same privacy rule as above: enum words, counts and the reservation id only.
const OUTCOMES = new Set(['charged', 'nochange', 'flagged', 'failed', 'ok']);
function outcome({ fn, ref, outcome: o, reworded, points, withheld, guard }) {
  try {
    const line = { fn: FNS.has(fn) ? fn : 'unknown', outcome: OUTCOMES.has(o) ? o : 'unknown', reworded: count(reworded), points: count(points), withheld: count(withheld), guard: typeof guard === 'string' && /^[a-z0-9-]{1,40}$/.test(guard) ? guard : null,
      ref: typeof ref === 'string' && UUID_RE.test(ref) ? ref : null };
    console.log(`ai-outcome ${JSON.stringify(line)}`);
    return line;
  } catch (e) { return null; }
}

module.exports = { record, outcome, estimateUsd };
