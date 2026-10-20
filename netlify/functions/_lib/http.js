// Small request helpers shared by the AI endpoints.
function readJsonBody(event, maxBytes) {
  const raw = event.body || '';
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return { ok: false, status: 413, error: 'That request is too large. Please shorten your text and try again.' };
  }
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return { ok: true, body };
  } catch (e) {
    return { ok: false, status: 400, error: 'Malformed request' };
  }
}

module.exports = { readJsonBody };
