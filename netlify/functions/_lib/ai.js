// One place that talks to the AI provider. Every failure mode (HTTP error, timeout, truncated
// output, empty or malformed output) becomes an AiError, so callers can release the reservation
// instead of charging for a result that never arrived.
const { get } = require('./config');

class AiError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = 'AiError';
    this.reason = reason;
    this.detail = detail;
  }
}

async function callClaude({ prompt, maxTokens, timeoutMs, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const cfg = get();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
          messages: [{ role: 'user', content: prompt }]
        })
      });
    } catch (e) {
      if (controller.signal.aborted) throw new AiError('timeout');
      throw new AiError('network', e && e.name);
    }
    if (!res.ok) throw new AiError('upstream_status', res.status);
    let data;
    try { data = await res.json(); } catch (e) { throw new AiError('bad_response'); }
    if (data && data.stop_reason === 'max_tokens') throw new AiError('truncated');
    const text = data && data.content && data.content[0] && data.content[0].text;
    if (typeof text !== 'string' || !text.trim()) throw new AiError('empty');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch (e) { throw new AiError('bad_json'); }
}

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

// A parsed resume must at least look like a resume.
function assertResumeShape(o) {
  if (!isObject(o) || !(typeof o.name === 'string' || Array.isArray(o.experience))) throw new AiError('bad_shape');
  for (const k of ['experience', 'education', 'certifications', 'projects', 'awards']) {
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

module.exports = { AiError, callClaude, extractJson, assertResumeShape, assertTailorShape, isObject };
