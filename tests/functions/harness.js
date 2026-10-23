// Runs the REAL Netlify handlers against a REAL (local, disposable) Postgres. Only two things are faked:
//   1. @supabase/supabase-js  -> a thin adapter that sends rpc()/from().select() to the local database
//      as service_role (so the grants in the migrations are genuinely exercised);
//   2. global fetch           -> the AI provider, with scripted failure modes. No network, no real key.
const Module = require('module');
const path = require('path');
const H = require('../db/helpers');

const FUNCS = path.join(__dirname, '..', '..', 'netlify', 'functions');

function makeClient(pool) {
  const run = async (sql, params) => {
    try { return { rows: (await pool.query(sql, params)).rows, error: null }; }
    catch (e) { return { rows: null, error: e }; }
  };
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
      const exec = async () => {
        const r = await run(sql, keys.map((k) => args[k]));
        if (r.error) return { data: null, error: r.error };
        const scalar = r.rows.length === 1 && Object.keys(r.rows[0]).length === 1 && fn in r.rows[0];
        return { data: scalar ? r.rows[0][fn] : r.rows, error: null };
      };
      return {
        then: (res, rej) => exec().then(res, rej),
        maybeSingle: async () => { const r = await exec(); return r.error ? r : { data: r.data[0] ?? null, error: null }; }
      };
    },
    // Minimal query builder: select / eq / gt / order / limit, awaited or finished with maybeSingle().
    from(table) {
      return { select: (cols) => {
        const where = []; const params = []; const order = []; let lim = null;
        const q = {
          eq(col, val) { params.push(val); where.push(`${col} = $${params.length}`); return q; },
          gt(col, val) { params.push(val); where.push(`${col} > $${params.length}`); return q; },
          order(col, o) { order.push(`${col} ${o && o.ascending === false ? 'desc' : 'asc'}`); return q; },
          limit(n) { lim = n; return q; },
          async _run(single) {
            const sql = `select ${cols} from public.${table}${where.length ? ' where ' + where.join(' and ') : ''}${order.length ? ' order by ' + order.join(', ') : ''}${single ? ' limit 1' : lim ? ' limit ' + lim : ''}`;
            const r = await run(sql, params);
            if (r.error) return { data: null, error: r.error };
            return { data: single ? (r.rows[0] ?? null) : r.rows, error: null };
          },
          maybeSingle() { return q._run(true); },
          then(res, rej) { return q._run(false).then(res, rej); }
        };
        return q;
      } };
    }
  };
}

let currentPool = null;
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return { createClient: () => makeClient(currentPool) };
  return origLoad.call(this, request, ...rest);
};

// Fresh handler modules (the helper caches its client) bound to the given pool.
function loadHandlers(pool) {
  currentPool = pool;
  for (const k of Object.keys(require.cache)) if (k.startsWith(FUNCS)) delete require.cache[k];
  const load = (n) => require(path.join(FUNCS, n));
  return {
    parse: load('parse-resume').handler, tailor: load('tailor-resume').handler,
    polish: load('polish-resume').handler, exportResume: load('export-resume'), polishModule: load('polish-resume'),
    consume: load('consume-generation').handler, verify: load('verify-license').handler,
    license: load('_lib/license'), tokens: load('_lib/token'), FUNCS
  };
}

const post = (body, extra = {}) => ({ httpMethod: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseBody = (res) => JSON.parse(res.body);

const GOOD_RESUME = { name: 'Jordan Ellis', contact: { email: 'jordan.ellis@example.com' }, summary: { tagline: '', bullets: [], skills: ['Customer service'] },
  experience: [{ title: 'Retail Associate', company: 'Fictional Maple Market', start: 'June 2023', end: 'August 2026', bullets: ['Assisted customers'] }],
  education: [], certifications: [], projects: [], awards: [] };

// A genuine, FAITHFUL rewrite of one line, worth 3 points under the collective rule (_lib/scoring.js): two or more words are put in, one of them a
// plain verb the line did not have ("Completed"), and no other word is new, so the integrity checks accept it and it is a real rewrite, not a touch-up.
function realReword(line) {
  const t = String(line).trim().replace(/[.!]+$/, '');
  return `Completed the ${t.replace(/^./, (c) => c.toLowerCase())}`;
}

// Polish replies. ECHO = the AI hands the customer's resume back untouched (the Taylor Rivera case).
const ECHO = (r) => r;
function REWORD_FIRST_BULLET(r) {
  const o = JSON.parse(JSON.stringify(r));
  for (const list of [o.summary && o.summary.bullets, ...['experience', 'projects', 'volunteer'].map((k) => (o[k] || []).map((e) => e.bullets))].flat().filter(Array.isArray)) {
    // A real but FAITHFUL change: it adds no new content word, number, beneficiary or role, so the integrity checks accept it.
    if (list.length) { list[0] = realReword(list[0]); return o; }
  }
  o.summary = { ...(o.summary || {}), tagline: realReword((o.summary && o.summary.tagline) || 'Seeking work in retail') };
  return o;
}

// Scriptable AI provider. mode: ok | http500 | hang | truncated | notjson | badshape | empty | throw
function installAi(state) {
  state.calls = 0; state.mode = state.mode || 'ok'; state.delayMs = state.delayMs || 0;
  state.inflight = 0; state.maxInflight = 0;
  global.fetch = async (url, opts) => {
    state.calls++;
    state.inflight++; state.maxInflight = Math.max(state.maxInflight, state.inflight);
    try { return await respond(url, opts); } finally { state.inflight--; }
  };
  const respond = async (url, opts) => {
    const mode = state.mode;
    if (state.delayMs) await sleep(state.delayMs);
    if (mode === 'hang') return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    if (mode === 'throw') throw new Error('socket hang up');
    if (mode === 'http500') return { ok: false, status: 500, json: async () => ({ error: { type: 'overloaded_error' } }) };
    const body = JSON.parse(opts.body);
    (state.bodies = state.bodies || []).push(body);
    // Reject what the real Sonnet 5.5 API rejects, so a regression in the request shape fails the suite instead of production.
    const bad = (message) => ({ ok: false, status: 400, json: async () => ({ type: 'error', error: { type: 'invalid_request_error', message } }) });
    if (body.model !== 'claude-sonnet-5-5') return { ok: false, status: 404, json: async () => ({ type: 'error', error: { type: 'not_found_error', message: `model: ${body.model}` } }) };
    if (['temperature', 'top_p', 'top_k'].some((k) => k in body)) return bad('sampling parameters are not supported');
    if (body.thinking && body.thinking.type === 'disabled') return bad('To turn thinking off on this model, send "thinking": {"type": "between_tools"}');
    if (body.messages[body.messages.length - 1].role !== 'user') return bad('This model does not support assistant message prefill.');
    const prompt = body.messages[0].content;
    state.lastPrompt = prompt;
    const isTailor = /tailoring assistant/.test(prompt);
    const isPolish = /careful resume editor/.test(prompt);
    // Polish default: a genuine rewording of the customer's first bullet (the prompt embeds their resume after "Resume JSON:"), so a
    // default "success" really is a meaningful improvement and is charged. Tests that need an unchanged or cosmetic-only reply
    // set state.polishPayload (see ECHO below).
    const polished = isPolish ? (state.polishPayload || REWORD_FIRST_BULLET)(JSON.parse(prompt.slice(prompt.indexOf('Resume JSON:') + 13))) : null;
    // Tailor / Analyze can be scripted too: state.tailorPayload(resume, jobDescription) and state.parsePayload(resumeText).
    const between = (a, b) => { const i = prompt.indexOf(a); if (i < 0) return ''; const s = i + a.length; const j = b ? prompt.indexOf(b, s) : prompt.length; return prompt.slice(s, j < 0 ? prompt.length : j).trim(); };
    const tailorOut = () => { if (!state.tailorPayload) return { resume: GOOD_RESUME, matchSummary: { matchedKeywords: ['customer service'], missingKeywords: ['Salesforce'], notes: 'ok' } };
      return state.tailorPayload(JSON.parse(between('Resume JSON:\n', '\n\nJob description:')), between('Job description:\n', null)); };
    const parseOut = () => (state.parsePayload ? state.parsePayload(between('Resume:\n', null)) : GOOD_RESUME);
    const payload = isPolish ? polished : isTailor ? tailorOut() : parseOut();
    let text = JSON.stringify(payload), stop = 'end_turn';
    if (mode === 'truncated') { text = text.slice(0, 40); stop = 'max_tokens'; }
    if (mode === 'notjson') text = 'Sorry, I cannot parse that.';
    if (mode === 'badshape') text = JSON.stringify([1, 2, 3]);
    if (mode === 'empty') text = '';
    if (mode === 'prose') text = `Here is the polished resume:\n${text}\nLet me know if you want changes.`;
    let content = [{ type: 'thinking', thinking: '', signature: 'sig-test' }, { type: 'text', text }];   // 5.5 can lead with a thinking block
    if (mode === 'multitext') content = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: text.slice(0, 30) }, { type: 'text', text: text.slice(30) }];
    if (mode === 'thinkingonly') content = [{ type: 'thinking', thinking: '', signature: 's' }];
    if (mode === 'refusal') { content = [{ type: 'text', text: '' }]; stop = 'refusal'; }
    if (mode === 'contextexceeded') stop = 'model_context_window_exceeded';
    const usage = state.usage || { input_tokens: Math.ceil(prompt.length / 3.8), output_tokens: Math.ceil(text.length / 3.6) };
    return { ok: true, status: 200, json: async () => ({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, usage }) };
  };
  return state;
}

// Capture console.error so tests can prove logs never contain codes or resume text.
function captureLogs() {
  const lines = []; const orig = console.error;
  console.error = (...a) => { lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  return { lines, restore: () => { console.error = orig; } };
}

module.exports = { H, loadHandlers, post, sleep, parseBody, installAi, captureLogs, GOOD_RESUME, FUNCS, ECHO, REWORD_FIRST_BULLET, realReword };
