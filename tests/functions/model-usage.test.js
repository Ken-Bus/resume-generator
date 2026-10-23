// Model migration (claude-sonnet-4-5 -> claude-sonnet-5-5) and the privacy-safe AI usage log.
// No network and no paid call: the AI provider is mocked (see harness.js, which REJECTS what the real API rejects: wrong model,
// thinking:"disabled", sampling parameters, assistant prefill). Fictional people only.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { H, loadHandlers, post, parseBody, installAi, GOOD_RESUME, ECHO, realReword } = require('./harness');
const FUNCS = path.join(__dirname, '..', '..', 'netlify', 'functions');
const ai = require(path.join(FUNCS, '_lib', 'ai'));
const usage = require(path.join(FUNCS, '_lib', 'usage'));
const cfg = require(path.join(FUNCS, '_lib', 'config')).get();

const KEY = 'TESTKEY-SENTINEL-do-not-log-0123456789';
const clone = (o) => JSON.parse(JSON.stringify(o));
const watchLog = () => { const lines = []; const orig = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.log = grab; console.warn = grab; console.error = grab; return { lines, stop: () => Object.assign(console, orig) }; };
const usageLines = (lines) => lines.filter((l) => l.startsWith('ai-usage ')).map((l) => JSON.parse(l.slice(9)));

// ───────────────────────── configuration ─────────────────────────
test('configuration: Sonnet 5.5, no up-front thinking, output caps raised ~30% for the new tokenizer, price table matches the model', () => {
  assert.equal(cfg.MODEL, 'claude-sonnet-5-5');
  assert.deepEqual(cfg.THINKING, { type: 'between_tools' });                                  // 'disabled' would be a 400 on this model
  assert.deepEqual(cfg.PRICE_PER_MTOK, { input: 2, output: 10 });
  assert.equal(cfg.PARSE_MAX_TOKENS, 5200); assert.equal(cfg.TAILOR_MAX_TOKENS, 8000);
  // unchanged entitlement and anti-abuse settings
  assert.equal(cfg.TAILOR_MAX_PER_PAID_OP, 5); assert.equal(cfg.FAIL_WINDOW_MAX, 6); assert.equal(cfg.FAIL_DAY_MAX, 30); assert.equal(cfg.TAILOR_FORGIVEN_FAILURES, 2);
  assert.equal(cfg.NOCHANGE_WINDOW_MAX, 3); assert.equal(cfg.NOCHANGE_DAY_MAX, 10);
  assert.equal(cfg.RESUME_MAX_CHARS, 20000); assert.equal(cfg.JOB_DESC_MAX_CHARS, 10000);
});

test('no source file still names the retired model', () => {
  const fs = require('fs');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(FUNCS)) assert.equal(/sonnet-4-5|claude-3|20250929/.test(fs.readFileSync(f, 'utf8')), false, f);
});

// ───────────────────────── the request and the reply ─────────────────────────
const reply = (over = {}) => async (url, opts) => {
  reply.last = { url, opts, body: JSON.parse(opts.body) };
  return { ok: true, status: 200, json: async () => ({ id: 'msg_x', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '{"a":1}' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 }, ...over }) };
};
const call = (fetchImpl, extra = {}) => ai.callClaude({ prompt: 'PROMPT', maxTokens: 1234, timeoutMs: 2000, fetchImpl, fn: 'polish', ...extra });

test('request: exact model, no-thinking setting, token cap, one user message, none of the removed parameters, key only in the header', async () => {
  process.env.ANTHROPIC_API_KEY = KEY; const w = watchLog();
  try { await call(reply()); } finally { w.stop(); }
  const { url, opts, body } = reply.last;
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'thinking']);        // nothing else: no temperature/top_p/top_k, tools, prefill, betas
  assert.equal(body.model, 'claude-sonnet-5-5'); assert.deepEqual(body.thinking, { type: 'between_tools' }); assert.equal(body.max_tokens, 1234);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'PROMPT' }]);
  assert.equal(opts.headers['anthropic-version'], '2023-06-01'); assert.equal(opts.headers['x-api-key'], KEY);
  assert.equal(Object.keys(opts.headers).some((h) => /beta/i.test(h)), false);
  assert.equal(JSON.stringify(body).includes(KEY), false); assert.equal(w.lines.join('\n').includes(KEY), false);
});

test('reply: read by block type (a leading thinking block, several text blocks, extra block kinds) and never content[0]', async () => {
  assert.equal(await call(reply({ content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] })), '{"a":1}');
  assert.equal(await call(reply({ content: [{ type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'ok' }] })), 'ok');
});

test('unusable replies become AiError and say why: refusal, truncation, context limit, empty, thinking-only', async () => {
  const reason = async (over) => { try { await call(reply(over)); return null; } catch (e) { return e.reason; } };
  assert.equal(await reason({ stop_reason: 'refusal', content: [{ type: 'text', text: '' }] }), 'refused');
  assert.equal(await reason({ stop_reason: 'max_tokens' }), 'truncated');
  assert.equal(await reason({ stop_reason: 'model_context_window_exceeded' }), 'truncated');
  assert.equal(await reason({ content: [] }), 'empty');
  assert.equal(await reason({ content: [{ type: 'thinking', thinking: '', signature: 's' }] }), 'empty');
  assert.equal(await reason({ content: [{ type: 'text', text: '   ' }] }), 'empty');
  for (const r of ['refused', 'truncated', 'empty']) assert.equal(ai.isProviderFault(new ai.AiError(r)), false, `${r} may have cost money, so it counts toward the failure budget`);
  for (const status of [400, 404, 429, 500, 529]) {                                                    // retired/unknown model, overload, outage: provider faults, never counted
    const e = await call(async () => ({ ok: false, status, json: async () => ({}) })).catch((x) => x);
    assert.equal(e.reason, 'upstream_status'); assert.equal(ai.isProviderFault(e), true);
  }
});

test('JSON extraction tolerates fences and a sentence around the JSON, but still rejects non-JSON', () => {
  assert.deepEqual(ai.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(ai.extractJson('Here is the result:\n{"a":{"b":[1,2]}}\nHope that helps!'), { a: { b: [1, 2] } });
  for (const bad of ['Sorry, I cannot do that.', '{"a":', '', 'a } b { c']) assert.throws(() => ai.extractJson(bad), (e) => e.reason === 'bad_json');
});

// ───────────────────────── the usage log ─────────────────────────
test('usage log: one privacy-safe line per call with tokens, stop reason, estimated cost, duration and reservation id', async () => {
  const ref = '123e4567-e89b-42d3-a456-426614174000'; const w = watchLog();
  try { await call(reply(), { ref, prompt: 'Taylor Rivera taylor.rivera@example.com FG-ABCD-1234 SECRET RESUME TEXT' }); } finally { w.stop(); }
  const [u, ...rest] = usageLines(w.lines); assert.equal(rest.length, 0);
  assert.equal(u.fn, 'polish'); assert.equal(u.model, 'claude-sonnet-5-5'); assert.equal(u.in, 1000); assert.equal(u.out, 500); assert.equal(u.stop, 'end_turn');
  assert.equal(u.usd, 0.007);                                                                           // (1000 x $2 + 500 x $10) / 1,000,000
  assert.equal(u.ref, ref); assert.ok(Number.isInteger(u.ms) && u.ms >= 0);
  const text = w.lines.join('\n'); for (const s of ['Taylor', 'taylor.rivera', 'FG-ABCD', 'SECRET', 'PROMPT', KEY]) assert.equal(text.includes(s), false, s);
});

test('usage log: tokens are recorded even when the reply is unusable (they are billed), and a timeout is logged as unknown-cost', async () => {
  const w = watchLog();
  try {
    await call(reply({ stop_reason: 'max_tokens', usage: { input_tokens: 800, output_tokens: 8000 } })).catch(() => {});
    await call(reply({ stop_reason: 'refusal', content: [], usage: { input_tokens: 800, output_tokens: 3 } })).catch(() => {});
    await call(async (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))), { timeoutMs: 1000 }).catch(() => {});
  } finally { w.stop(); }
  const [a, b, c] = usageLines(w.lines);
  assert.deepEqual([a.stop, a.in, a.out, a.usd], ['max_tokens', 800, 8000, 0.0816]);
  assert.deepEqual([b.stop, b.in, b.out], ['refusal', 800, 3]);
  assert.deepEqual([c.stop, c.in, c.out, c.usd], ['timeout', null, null, null]);
});

test('usage log: only numbers, short words and UUIDs can ever appear; anything else is dropped; logging can never throw', () => {
  const w = watchLog(); let line;
  try {
    line = usage.record({ fn: 'resume text here', model: 'a model with spaces', ref: 'FG-ABCD-1234', ms: 'soon', price: cfg.PRICE_PER_MTOK,
      provider: { stop_reason: 'Taylor Rivera was here', usage: { input_tokens: 'Taylor', output_tokens: -5, cache_creation_input_tokens: 1e400 } } });
  } finally { w.stop(); }
  assert.deepEqual(line, { fn: 'unknown', model: null, in: null, out: null, stop: null, usd: 0, ms: null, ref: null });
  assert.equal(JSON.stringify(w.lines).includes('Taylor'), false); assert.equal(JSON.stringify(w.lines).includes('FG-ABCD'), false);
  const orig = console.log; console.log = () => { throw new Error('log sink down'); };
  try { assert.doesNotThrow(() => usage.record({ fn: 'polish', provider: { usage: { input_tokens: 1, output_tokens: 1 } }, price: cfg.PRICE_PER_MTOK })); } finally { console.log = orig; }
});

// ───────────────────────── end to end with fictional people (real handlers, real SQL, mocked AI) ─────────────────────────
const TAYLOR = { name: 'Taylor Rivera', contact: { email: 'taylor.rivera@example.com', location: 'Dayton, OH' }, summary: { tagline: 'Seeking a customer service position', bullets: [], skills: ['Teamwork', 'Customer service'] },
  experience: [], education: [{ degree: 'High School Diploma', school: 'Oakwood High School', date: '2026' }], certifications: [{ name: 'Food Handler Course', date: '2026' }],
  projects: [{ name: 'School food drive', description: 'Collected canned food for a local pantry', bullets: ['asked classmates to donate cans', 'sorted and counted the cans'] }],
  volunteer: [{ title: 'Volunteer', organization: 'Community Food Pantry', start: '2025', end: 'Present', bullets: ['packed grocery boxes on saturdays', 'greeted families as they arrived'] }], awards: [] };
const MICHAEL = { name: 'Michael Johnson', contact: { email: 'mj@example.com' }, summary: { tagline: 'Warehouse associate', bullets: [], skills: ['Forklift safety', 'Teamwork'] },
  experience: [{ title: 'Shift Lead', company: 'Fictional Freight Co', location: 'Dayton, OH', start: '2015', end: 'Present', summary: '', bullets: ['showed new people how to use the pallet jack', 'checked orders for accuracy', 'kept the dock clean and safe'] },
    { title: 'Warehouse Associate', company: 'Fictional Freight Co', location: 'Dayton, OH', start: '2004', end: '2015', summary: '', bullets: ['loaded and unloaded trucks', 'worked with the shipping team'] }],
  education: [{ degree: 'High School Diploma', school: 'Oakwood High', date: '1999' }], certifications: [], projects: [], volunteer: [], awards: [] };
const PRIYA = { name: 'Priya Nair', contact: { email: 'priya.nair@example.com' }, summary: { tagline: '', bullets: [], skills: ['Teamwork', 'Keeping records'] },
  experience: [{ title: 'Warehouse Associate', company: 'Fictional Supply Co', location: 'Dayton, OH', start: '2018', end: '2026', summary: '', bullets: ['answered customer questions by phone and in person', 'kept accurate records of shipments', 'followed safety procedures'] }],
  education: [{ degree: 'High School Diploma', school: 'Lakeview High', date: '2017' }], certifications: [], projects: [], volunteer: [], awards: [] };

// An honest rewrite of the LAST bullet of the first job: worth a generation by itself under the 3-point rule (the personas' own edits are mostly re-wordings).
const BOOST = (o) => { const b = o.experience[0].bullets; b[b.length - 1] = realReword(b[b.length - 1]); };
const PEOPLE = [
  { who: 'first-time applicant (Taylor)', profile: 'first', src: TAYLOR, target: 'customer service', improve: (o) => { o.projects[0].bullets = ['Asked classmates to donate canned food', 'Counted and sorted the donated cans']; o.volunteer[0].bullets = ['Packed grocery boxes on Saturdays', 'Greeted families on arrival']; },
    facts: (o) => { assert.equal(o.education[0].school, 'Oakwood High School'); assert.equal(o.volunteer[0].organization, 'Community Food Pantry'); assert.equal(o.volunteer[0].start, '2025'); assert.equal(o.experience.length, 0); } },
  { who: 'experienced worker (Michael)', boost: BOOST, profile: 'experienced', src: MICHAEL, target: 'warehouse lead', improve: (o) => { o.experience[0].bullets = ['Taught new people to use the pallet jack', 'Order accuracy checks', 'Kept the dock clean and safe']; o.experience[1].bullets = ['Loaded and unloaded trucks', 'Worked with the shipping team']; },
    facts: (o) => { assert.deepEqual(o.experience.map((e) => [e.title, e.company, e.start, e.end]), [['Shift Lead', 'Fictional Freight Co', '2015', 'Present'], ['Warehouse Associate', 'Fictional Freight Co', '2004', '2015']]); assert.equal(o.education[0].date, '1999'); } },
  { who: 'career changer (Priya)', boost: BOOST, profile: 'changer', src: PRIYA, target: 'customer support', improve: (o) => { o.experience[0].bullets = ['Responded to customer questions by phone and in person', 'Kept accurate shipment records', 'Followed safety procedures']; },
    facts: (o) => { assert.equal(o.experience[0].company, 'Fictional Supply Co'); assert.equal(o.experience[0].end, '2026'); assert.equal(o.education[0].school, 'Lakeview High'); } }
];

test('migration end to end: every paid feature on the new model with fictional people (polish: meaningful / no-change / cosmetic / invented facts; analyze; tailor)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_model_usage');
  await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2); await H.applyMigration(db, H.MIG3);
  const hs = loadHandlers(db.pool('service_role', 40)); const fake = installAi({});
  const SECRET = 'test-secret-test-secret-test-secret-0123456789';
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: KEY, TAILOR_TOKEN_SECRET: SECRET, AI_TIMEOUT_MS: '1000' });
  let n = 0; const seed = async (uses = 5) => { const c = `FG-M${String(++n).padStart(3, '0')}-CCCC`; await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const uses = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const rows = async (c) => (await db.admin('select status, failure_counted fc from license_reservations where code=$1 order by created_at', [c])).rows;
  const reset = () => { fake.mode = 'ok'; fake.delayMs = 0; fake.calls = 0; fake.polishPayload = null; fake.bodies = []; fake.usage = null; hs.polishModule._recent.clear(); hs.polishModule._nochange._events.clear(); };
  const polish = (code, p, extra = {}) => hs.polish(post({ code, resume: p.src, target: p.target, profile: p.profile, ...extra }));

  for (const p of PEOPLE) {
    await t.test(`${p.who}: a meaningful polish charges exactly one generation; facts, dates, schools and employers are untouched`, async () => {
      reset(); const c = await seed(); fake.polishPayload = (r) => { const o = clone(r); p.improve(o); if (p.boost) p.boost(o); return o; }; const w = watchLog();
      let b; try { b = parseBody(await polish(c, p)); } finally { w.stop(); }
      assert.equal(b.charged, true); assert.equal(b.usesRemaining, 4); assert.ok(b.tailorToken); assert.ok(b.changes.reworded >= 1, JSON.stringify(b.changes));
      p.facts(JSON.parse(b.result)); assert.equal(await uses(c), 4); assert.deepEqual(await rows(c), [{ status: 'committed', fc: false }]);
      const body = fake.bodies[0]; assert.equal(body.model, 'claude-sonnet-5-5'); assert.deepEqual(body.thinking, { type: 'between_tools' });
      assert.ok(body.messages[0].content.includes(p.profile === 'first' ? 'FIRST resume' : p.profile === 'experienced' ? 'HAS WORK HISTORY' : 'CHANGING to a different kind of work'));
      const [u] = usageLines(w.lines); assert.equal(u.fn, 'polish'); assert.ok(u.in > 0 && u.out > 0 && u.usd > 0); assert.match(u.ref, /^[0-9a-f-]{36}$/);
      const text = w.lines.join('\n'); for (const s of [c, p.src.name, p.src.contact.email, KEY]) assert.equal(text.includes(s), false, `log must not contain ${s}`);
    });

    await t.test(`${p.who}: nothing meaningful (unchanged, or only capitals/punctuation) charges ZERO, is not a counted failure, and sends no text back`, async () => {
      for (const make of [ECHO, (r) => { const o = clone(r); (function w(v) { if (Array.isArray(v)) v.forEach((x, i) => { if (typeof x === 'string') v[i] = ` ${x[0].toUpperCase()}${x.slice(1)}. `; else w(x); }); else if (v && typeof v === 'object') Object.keys(v).forEach((k) => { if (['bullets', 'skills'].includes(k)) w(v[k]); else if (k !== 'contact') w(v[k]); }); })(o); return o; }]) {
        reset(); const c = await seed(); fake.polishPayload = make; const b = parseBody(await polish(c, p));
        assert.equal(b.noChange, true); assert.equal(b.charged, false); assert.equal(b.usesRemaining, 5); assert.equal(b.result, undefined);
        assert.equal(await uses(c), 5); assert.deepEqual(await rows(c), [{ status: 'released', fc: false }]);
      }
    });

    await t.test(`${p.who}: invented facts are restored, dropped or WITHHELD whatever the new model writes; honest lines in the same reply are still accepted (one charge)`, async () => {
      reset(); const c = await seed();
      fake.polishPayload = (r) => { const o = clone(r); p.improve(o); if (p.boost) p.boost(o); o.name = 'Someone Else'; o.education[0].school = 'Invented University'; o.education[0].date = '2031';
        o.experience.push({ title: 'Store Manager', company: 'Invented Corp', location: '', start: '2020', end: '2024', summary: '', bullets: ['Managed a team of 12 and increased sales by 40%'] });
        o.projects.push({ name: 'Invented project', description: 'Led a campaign', bullets: ['Won a state award'] });
        if (p.src.experience.length) { o.experience[0].company = 'Invented Corp'; o.experience[0].start = '1990'; o.experience[0].bullets[0] = 'Supervised a team of 15 and increased output by 40%'; }
        else o.projects[0].bullets[0] = 'Organized a food drive that collected 1,200 cans';
        o.summary.skills = [...(o.summary.skills || []), 'Salesforce']; o.summary.tagline = 'Motivated, results-driven professional'; return o; };
      const b = parseBody(await polish(c, p)); const out = JSON.parse(b.result);
      assert.equal(out.name, p.src.name); assert.equal(out.education[0].school, p.src.education[0].school); assert.equal(out.education[0].date, p.src.education[0].date);
      assert.equal(out.experience.length, p.src.experience.length); assert.equal(out.projects.length, p.src.projects.length);          // invented entries dropped
      p.src.experience.forEach((e, i) => { assert.equal(out.experience[i].company, e.company); assert.equal(out.experience[i].start, e.start); });
      const text = JSON.stringify(out);
      for (const bad of ['Salesforce', 'Motivated', 'results-driven', 'Invented', '1,200', '40%', 'Supervised a team', 'Managed a team', 'state award', 'Led a campaign']) assert.equal(text.includes(bad), false, `${bad} must not reach the resume`);
      const reasons = b.withheld.map((u) => u.reasons.join(' ')).join(' | ');
      assert.match(reasons, /number not in your resume/); assert.match(reasons, /skill not found|praise or personality/);
      assert.ok(b.withheld.length >= 2, reasons); assert.deepEqual(b.unverified, []);
      assert.equal(b.charged, true); assert.equal(b.usesRemaining, 4); assert.ok(b.changes.reworded >= 1);                                  // the honest improvement was accepted and charged once
    });
  }

  await t.test('failures on the new model never charge: refusal, thinking-only reply, context limit, truncation, model not found; only provider faults are uncounted', async () => {
    for (const [mode, counted] of [['refusal', true], ['thinkingonly', true], ['contextexceeded', true], ['truncated', true], ['http500', false]]) {
      reset(); const c = await seed(); fake.mode = mode; const r = await polish(c, PEOPLE[0]);
      assert.equal(r.statusCode, 502, mode); assert.equal(await uses(c), 5, mode); assert.deepEqual(await rows(c), [{ status: 'released', fc: counted }], mode);
    }
  });

  await t.test('tolerant parsing end to end: a reply wrapped in a sentence, or split across text blocks, still works and is charged once', async () => {
    for (const mode of ['prose', 'multitext']) {
      reset(); const c = await seed(); fake.mode = mode; const r = await polish(c, PEOPLE[1]);
      assert.equal(r.statusCode, 200, mode); assert.equal(await uses(c), 4, mode);
    }
  });

  await t.test('Analyze and Tailor use the same model/request shape, each writes one usage line, and charging is unchanged (Analyze 1, Tailor 0)', async () => {
    reset(); const c = await seed(); const w = watchLog(); let a, tl;
    try {
      a = parseBody(await hs.parse(post({ code: c, resumeText: 'Jordan Ellis, retail associate at Fictional Maple Market' })));
      tl = await hs.tailor(post({ resumeData: GOOD_RESUME, jobDescription: 'Cashier: friendly service', tailorToken: a.tailorToken }));
    } finally { w.stop(); }
    assert.equal(tl.statusCode, 200); assert.equal(await uses(c), 4);
    assert.deepEqual(fake.bodies.map((b) => [b.model, b.thinking.type]), [['claude-sonnet-5-5', 'between_tools'], ['claude-sonnet-5-5', 'between_tools']]);
    const lines = usageLines(w.lines); assert.deepEqual(lines.map((l) => l.fn), ['analyze', 'tailor']);
    assert.equal(lines[0].ref, lines[1].ref, 'Tailor lines are tied to the paid generation that authorised them');
    assert.equal(w.lines.join('\n').includes('Jordan'), false); assert.equal(w.lines.join('\n').includes(c), false);
  });

  await t.test('a call that fails after the AI ran still leaves its usage line (the tokens were billed), tied to the released reservation', async () => {
    reset(); const c = await seed(); fake.mode = 'truncated'; fake.usage = { input_tokens: 1700, output_tokens: 8000 }; const w = watchLog();
    try { await polish(c, PEOPLE[0]); } finally { w.stop(); }
    const [u] = usageLines(w.lines); assert.deepEqual([u.fn, u.stop, u.in, u.out], ['polish', 'max_tokens', 1700, 8000]); assert.equal(u.usd, 0.0834);
    assert.equal(await uses(c), 5);
  });

  await db.drop?.();
});
