// One place that talks to the AI provider. Every failure mode (HTTP error, timeout, truncated
// output, empty or malformed output) becomes an AiError, so callers can release the reservation
// instead of charging for a result that never arrived.
const { get } = require('./config');
const usage = require('./usage');

class AiError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = 'AiError';
    this.reason = reason;
    this.detail = detail;
  }
}

// fn = 'analyze' | 'polish' | 'tailor' and ref = the reservation id, both only for the usage log (see _lib/usage.js).
async function callClaude({ prompt, maxTokens, timeoutMs, fetchImpl, fn, ref }) {
  const doFetch = fetchImpl || fetch;
  const cfg = get();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const logUsage = (provider, aborted) => usage.record({ fn, model: cfg.MODEL, provider, ms: Date.now() - started, ref, aborted, price: cfg.PRICE_PER_MTOK });
  try {
    let res;
    try {
      res = await doFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: cfg.MODEL,
          max_tokens: maxTokens,
          thinking: cfg.THINKING,
          messages: [{ role: 'user', content: prompt }]
        })
      });
    } catch (e) {
      if (controller.signal.aborted) { logUsage(null, true); throw new AiError('timeout'); }
      throw new AiError('network', e && e.name);
    }
    if (!res.ok) throw new AiError('upstream_status', res.status);
    let data;
    try { data = await res.json(); } catch (e) { throw new AiError('bad_response'); }
    logUsage(data, false);                                       // tokens are billed even when the reply turns out to be unusable
    const stop = data && data.stop_reason;
    if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') throw new AiError('truncated');
    if (stop === 'refusal') throw new AiError('refused');
    // Read the reply by block type: a response may begin with a (possibly empty) `thinking` block, so content[0] is not
    // necessarily the text.
    const blocks = data && Array.isArray(data.content) ? data.content : [];
    const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    if (!text.trim()) throw new AiError('empty');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch (e) { /* fall through: the model may have added a sentence around the JSON */ }
  const a = clean.indexOf('{'); const b = clean.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(clean.slice(a, b + 1)); } catch (e) { /* not JSON either */ } }
  throw new AiError('bad_json');
}

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

// A parsed resume must at least look like a resume.
function assertResumeShape(o) {
  if (!isObject(o) || !(typeof o.name === 'string' || Array.isArray(o.experience))) throw new AiError('bad_shape');
  for (const k of ['experience', 'education', 'certifications', 'projects', 'volunteer', 'awards']) {
    if (o[k] !== undefined && !Array.isArray(o[k])) throw new AiError('bad_shape');
  }
  return o;
}

function assertTailorShape(o) {
  if (!isObject(o) || !isObject(o.resume)) throw new AiError('bad_shape');
  assertResumeShape(o.resume);
  const ms = isObject(o.matchSummary) ? o.matchSummary : {};
  o.matchSummary = {
    matchedKeywords: Array.isArray(ms.matchedKeywords) ? ms.matchedKeywords.filter((x) => typeof x === 'string') : [],
    missingKeywords: Array.isArray(ms.missingKeywords) ? ms.missingKeywords.filter((x) => typeof x === 'string') : [],
    notes: typeof ms.notes === 'string' ? ms.notes : ''
  };
  return o;
}

// A provider outage costs nothing and is never the customer's doing, so it never counts against a failure
// budget. Everything else (timeout, truncated/empty/malformed output) may have been billed, so it does.
function isProviderFault(err) {
  return !!err && (err.reason === 'upstream_status' || err.reason === 'network');
}

module.exports = { isProviderFault, AiError, callClaude, extractJson, assertResumeShape, assertTailorShape, isObject };
