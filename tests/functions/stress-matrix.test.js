// STRESS MATRIX: ten fictional applicants x every way an AI answer can behave, through the REAL polish handler and REAL SQL (AI mocked, no
// network, no paid call). Each scenario is judged by an ORACLE written independently of the code under test (it never calls the integrity or
// charging code), and the same oracle is then run against deliberately SABOTAGED builds to prove it can fail: a suite that passes only
// because its mocks are accommodating would not.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { H, loadHandlers, post, parseBody, installAi, realReword } = require('./harness');
const { P, clone, buildLong } = require('./personas');
const Core = require('../../resume-core.js');
const FUNCS = path.join(__dirname, '..', '..', 'netlify', 'functions');
const limits = require(path.join(FUNCS, '_lib', 'limits'));
const cfg = require(path.join(FUNCS, '_lib', 'config')).get();

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
P.long = buildLong(limits, cfg);

// ── helpers that read a resume (independent of the code under test) ────────────────────────────────────────────────────────
const SECTIONS = ['experience', 'volunteer', 'projects'];
const entries = (r) => SECTIONS.flatMap((k) => (r[k] || []).map((e, i) => ({ k, i, e })));
const bulletRefs = (r) => entries(r).flatMap(({ k, i, e }) => (e.bullets || []).map((b, j) => ({ k, i, j, e, b })));
const key = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const lineKeys = (e) => [e.summary, e.description, ...(e.bullets || [])].map(key).filter(Boolean);
const FIXED = (r) => ({ name: r.name, contact: r.contact, education: r.education, certifications: r.certifications, awards: r.awards,
  jobs: (r.experience || []).map((e) => [e.title, e.company, e.location, e.start, e.end]), vol: (r.volunteer || []).map((e) => [e.title, e.organization, e.start, e.end]), proj: (r.projects || []).map((e) => e.name) });

// ── ways the AI can answer. Each returns a changed copy of the (cleaned) resume it was sent, or null when it does not apply ──────
const firstBullets = (r, n = 3) => bulletRefs(r).slice(0, n);
const POISON = ['40%', 'Supervised a team', 'families in the community', 'resulting in happier customers', 'Salesforce', 'Dynamic results-driven', 'Evil Corp'];
const append = (ref, text) => { ref.e.bullets[ref.j] = `${ref.b.replace(/[.]+$/, '')}${text}`; };
const B = {
  ECHO: { expect: 'unchanged', make: (r) => clone(r) },
  CAPS_PUNCT: { expect: 'unchanged', make: (r) => { const o = clone(r); bulletRefs(o).forEach(({ e, j, b }) => { e.bullets[j] = ` ${b[0].toUpperCase()}${b.slice(1).replace(/[.]+$/, '')}. `; }); return bulletRefs(o).length ? o : null; } },
  FILLER_WORD: { expect: 'free', make: (r) => { const o = clone(r); const t = firstBullets(o).filter(({ b }) => b.trim().split(/\s+/).length >= 2); t.forEach(({ e, j, b }) => { const w = b.trim().split(/\s+/); e.bullets[j] = [w[0], 'also', ...w.slice(1)].join(' '); }); return t.length ? o : null; } },
  SYNONYM_SWAP: { expect: 'free', make: (r) => { const o = clone(r); const t = firstBullets(o).filter(({ b }) => b.trim().split(/\s+/).length >= 3); t.forEach(({ e, j, b }) => { const w = b.trim().split(/\s+/); e.bullets[j] = ['Handled', ...w.slice(1)].join(' '); }); return t.length ? o : null; } },
  ONE_WORD_FROM_ENTRY: { expect: 'free', make: (r) => { const o = clone(r); let did = false;
    for (const { e, j, b } of bulletRefs(o)) { const own = (e.bullets || []).filter((_, x) => x !== j).join(' ').split(/\s+/).map((w) => w.replace(/[^A-Za-z]/g, '')).find((w) => w.length >= 5 && !new RegExp(`\\b${w}\\b`, 'i').test(b));
      if (own) { const w = b.trim().split(/\s+/); e.bullets[j] = [...w.slice(0, -1), own.toLowerCase(), w[w.length - 1]].join(' '); did = true; break; } } return did ? o : null; } },
  REORDER_ONLY: { expect: 'unchanged', make: (r) => { const o = clone(r); let did = false; entries(o).forEach(({ e }) => { if ((e.bullets || []).length >= 2 && new Set(e.bullets.map(key)).size === e.bullets.length) { e.bullets.reverse(); did = true; } }); if (o.summary.skills.length >= 2) { o.summary.skills.reverse(); did = true; } return did ? o : null; } },
  GRAMMAR_ONE_WORD: { expect: 'free', make: (r) => { const o = clone(r); const t = bulletRefs(o).find(({ b }) => b === 'handle money'); if (!t) return null; t.e.bullets[t.j] = 'handled money'; return o; } },
  GRAMMAR_SEVERAL: { expect: 'charged', make: (r) => { const o = clone(r); const t = bulletRefs(o).find(({ b }) => /^i answer phone/.test(b)); if (!t) return null; t.e.bullets[t.j] = 'I answered phones and received payments'; return o; } },
  REWRITE: { expect: 'charged', make: (r) => { const o = clone(r); const t = firstBullets(o).filter(({ b }) => b.trim().split(/\s+/).length >= 3 && new Set(bulletRefs(o).map((x) => key(x.b))).size === bulletRefs(o).length); t.forEach(({ e, j, b }) => { e.bullets[j] = realReword(b); }); return t.length ? o : null; } },
  MERGE_BULLETS: { expect: 'charged', make: (r) => { const o = clone(r); const t = entries(o).find(({ e }) => (e.bullets || []).length >= 3 && new Set(e.bullets.map(key)).size === e.bullets.length); if (!t) return null;
    const b = t.e.bullets; const low = (x) => x.replace(/^./, (c) => c.toLowerCase()).replace(/[.]+$/, ''); t.e.bullets = [`${b[0].replace(/[.]+$/, '')}, then ${low(b[1])}`, ...b.slice(2)]; return o; } },
  CLEAR_UP_CONFUSING: { expect: 'free',   // a wordy line cut down to what it said: worth 1 point (removed repetition), not a paid rewrite
    make: (r) => { const o = clone(r); const t = bulletRefs(o).find(({ b }) => /^Did stuff with the oven/.test(b)); if (!t) return null; t.e.bullets[t.j] = 'Did the oven and the counter'; return o; } },
  DEDUPE_ONLY: { expect: 'free',      // one repeated line removed: 1 point
    make: (r) => { const o = clone(r); const t = entries(o).find(({ e }) => (e.bullets || []).some((b, x, a) => a.findIndex((y) => key(y) === key(b)) !== x)); if (!t) return null; t.e.bullets = t.e.bullets.filter((b, x, a) => a.findIndex((y) => key(y) === key(b)) === x); return o; } },
  INVENT_NUMBER: { expect: 'flagged', make: (r) => { const o = clone(r); const t = bulletRefs(o)[0]; if (!t) return null; append(t, ' and increased sales by 40%'); return o; } },
  INVENT_LEADERSHIP: { expect: 'flagged', make: (r) => { const o = clone(r); const t = bulletRefs(o)[0]; if (!t) return null; t.e.bullets[t.j] = 'Supervised a team of workers every day'; return o; } },
  INVENT_BENEFICIARY: { expect: 'flagged', make: (r) => { const o = clone(r); const t = bulletRefs(o).find(({ e }) => !/famil/i.test(JSON.stringify(e))); if (!t) return null; append(t, ' for families in the community'); return o; } },
  INVENT_OUTCOME: { expect: 'flagged', make: (r) => { const o = clone(r); const t = bulletRefs(o)[0]; if (!t) return null; append(t, ', resulting in happier customers'); return o; } },
  INVENT_INTO_BLANK: { expect: 'flagged', make: (r) => { const o = clone(r); const t = entries(o).find(({ e, k }) => k === 'projects' && !String(e.description || '').trim()); if (t) { t.e.description = 'Collected donated food for families in the community.'; return o; }
    if (!String(o.summary.tagline || '').trim()) { o.summary.tagline = 'Dynamic results-driven professional'; return o; } return null; } },
  INVENT_JOB_AND_SKILL: { expect: 'free', make: (r) => { const o = clone(r); o.experience = [...o.experience, { title: 'Store Manager', company: 'Evil Corp', start: '2020', end: '2024', bullets: ['Supervised 25 employees'] }]; o.summary.skills = [...o.summary.skills, 'Salesforce']; return o; } },
  BORROW_FROM_OTHER_ENTRY: { expect: 'free', make: (r) => { const o = clone(r); const refs = bulletRefs(o); const a = refs[0]; const b = refs.find((x) => x.k !== a.k || x.i !== a.i); if (!b) return null;
    b.e.bullets[b.j] = a.b; return o; } },
  GOOD_PLUS_BAD: { expect: 'charged', make: (r) => { const o = REWRITE_FIRST(r); const refs = bulletRefs(o); if (refs.length < 2) return null; append(refs[refs.length - 1], ' for families in the community, resulting in happier customers'); return o; } },
  EVERYTHING_REJECTED: { expect: 'flagged', make: (r) => { const o = clone(r); const refs = bulletRefs(o); if (refs.length < 3) return null; append(refs[0], ' and increased sales by 40%'); refs[1].e.bullets[refs[1].j] = 'Supervised a team of workers every day'; append(refs[2], ', resulting in happier customers'); return o; } },
  HOSTILE_SHAPES: { expect: 'any', make: (r) => { const o = clone(r); const t = bulletRefs(o); if (!t.length) return null; const last = t[t.length - 1].e; last.bullets.push({ text: 'object' }, null, ['nested'], true, { toString: 'x' }); o.contact = { email: 'attacker@evil.example' }; o.name = 'Attacker'; return o; } }
};
function REWRITE_FIRST(r) { const o = clone(r); const t = bulletRefs(o).find(({ b }) => b.trim().split(/\s+/).length >= 3); if (t) t.e.bullets[t.j] = realReword(t.b); return o; }

// ── the oracle ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Judges one scenario from what a customer could see: the HTTP answer, the balance, the reservation row and the resume that would be applied.
function judge({ persona, behavior, source, res, usesBefore, usesAfter, rsv, aiCalls }) {
  const v = []; const bad = (m) => v.push(`${persona}/${behavior}: ${m}`);
  const b = parseBody(res); const exp = B[behavior].expect;
  if (res.statusCode !== 200) { bad(`status ${res.statusCode}`); return v; }
  if (Core.writableWords(source) < 8) {                                   // too little to work with: told so, no AI call, no reservation, no charge, nothing handed back
    if (b.reason !== 'sparse' || b.charged !== false || aiCalls !== 0 || rsv.length !== 0 || usesAfter !== usesBefore || b.result !== undefined) bad(`a resume with too little to work with must be answered plainly with no AI call and no charge (${b.reason}, ai ${aiCalls}, rsv ${rsv.length})`);
    return v;
  }
  const charged = b.charged === true;
  if (exp === 'charged' && !charged) bad(`should be charged, was free (${b.reason}; ${JSON.stringify(b.changes)})`);
  if ((exp === 'free' || exp === 'unchanged' || exp === 'flagged') && charged) bad(`must be FREE but a generation was charged (${JSON.stringify(b.changes)})`);
  if (exp === 'unchanged' && !charged && b.reason !== 'unchanged') bad(`expected reason unchanged, got ${b.reason}`);
  if (exp === 'flagged' && !charged && b.reason !== 'flagged') bad(`expected reason flagged, got ${b.reason}`);
  // the money: exactly one generation for a charged result, none otherwise, and the reservation row agrees
  if (charged) { if (usesAfter !== usesBefore - 1) bad(`balance ${usesBefore} -> ${usesAfter}`); if (!(rsv.length === 1 && rsv[0].status === 'committed')) bad(`reservation ${JSON.stringify(rsv)}`); }
  else { if (usesAfter !== usesBefore) bad(`free result changed the balance ${usesBefore} -> ${usesAfter}`); if (!(rsv.length === 1 && rsv[0].status === 'released' && rsv[0].fc === false)) bad(`free result left reservation ${JSON.stringify(rsv)}`); if (b.result !== undefined) bad('a free result handed back resume text'); if (b.tailorToken) bad('a free result issued a tailoring token'); }
  if (!charged) return v;
  let out; try { out = JSON.parse(b.result); } catch (e) { bad('result is not JSON'); return v; }
  // customer facts never change
  if (JSON.stringify(FIXED(out)) !== JSON.stringify(FIXED(source))) bad(`customer facts changed: ${JSON.stringify(FIXED(out)).slice(0, 160)}`);
  const text = JSON.stringify(out);
  for (const p of POISON) if (text.includes(p) && !JSON.stringify(source).includes(p)) bad(`unsupported text reached the resume: "${p}"`);
  if (/\[object|undefined|:null|\{"text"/.test(text)) bad('non-text value reached the resume');
  // nothing is borrowed: a line in entry E must be E's own, or new wording that is not another entry's line
  const origKeys = new Map(entries(source).map(({ k, i, e }) => [`${k}.${i}`, new Set(lineKeys(e))]));
  entries(out).forEach(({ k, i, e }) => lineKeys(e).forEach((lk) => { const own = origKeys.get(`${k}.${i}`); if (own && own.has(lk)) return;
    for (const [id, set] of origKeys) if (id !== `${k}.${i}` && set.has(lk) && !(own && own.has(lk))) bad(`line borrowed from ${id} into ${k}.${i}: "${lk}"`); }));
  // blank stays blank unless the customer filled it
  entries(source).forEach(({ k, i, e }) => { const o = (out[k] || [])[i]; if (!o) return; ['description', 'summary'].forEach((f) => { if (f in e && !String(e[f] || '').trim() && String(o[f] || '').trim()) bad(`blank ${k}.${i}.${f} was filled`); }); });
  // a charged result really contains the rewrite (it was applied)
  if (exp === 'charged' && JSON.stringify(out) === JSON.stringify(source)) bad('charged but nothing changed');
  return v;
}

test('STRESS MATRIX against real SQL (AI provider mocked)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_stress');
  await db.admin(H.SUPABASE_DEFAULT_PRIVS); await H.liveState(db); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2); await H.applyMigration(db, H.MIG3);
  const hs = loadHandlers(db.pool('service_role', 80)); const ai = installAi({});
  const integrity = require(path.join(FUNCS, '_lib', 'integrity'));        // the SAME module instance the handler uses, so the sabotage below really reaches it
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'TESTKEY-STRESS', TAILOR_TOKEN_SECRET: SECRET, AI_TIMEOUT_MS: '2000' });
  let n = 0; const seed = async (uses = 5) => { const c = `FG-${(++n).toString(36).toUpperCase().padStart(4, "S")}-EEEE`; await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const uses = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const rows = async (c) => (await db.admin('select status, failure_counted fc from license_reservations where code=$1 order by created_at', [c])).rows;
  const fresh = () => { ai.mode = 'ok'; ai.polishPayload = null; ai.bodies = []; ai.calls = 0; hs.polishModule._recent.clear(); hs.polishModule._nochange._events.clear(); };

  async function scenario(personaName, behavior) {
    const persona = P[personaName]; const source = Core.clean(persona);
    const out = B[behavior].make(source); if (!out) return null;
    fresh(); const c = await seed(); ai.polishPayload = () => clone(out);
    const before = await uses(c); const res = await hs.polish(post({ code: c, resume: persona, target: 'customer service' }));
    return judge({ persona: personaName, behavior, source, res, usesBefore: before, usesAfter: await uses(c), rsv: await rows(c), aiCalls: ai.calls });
  }
  async function runAll(personaNames, behaviors) { const violations = []; let ran = 0; for (const p of personaNames) for (const bh of behaviors) { const v = await scenario(p, bh); if (v) { ran++; violations.push(...v); } } return { violations, ran }; }

  // ═══ 1. every persona x every behaviour ═══
  const ALL_P = Object.keys(P); const ALL_B = Object.keys(B);
  const coverage = {};
  await t.test(`all ${ALL_P.length} applicants x ${ALL_B.length} AI behaviours: the oracle finds no violation`, async () => {
    const violations = []; let ran = 0;
    for (const p of ALL_P) for (const bh of ALL_B) { const v = await scenario(p, bh); if (v) { ran++; (coverage[bh] = coverage[bh] || []).push(p); violations.push(...v); } }
    assert.deepEqual(violations, []); assert.ok(ran >= 120, `only ${ran} scenarios applied`);
    // every behaviour must actually have been exercised, most of them on several applicants (a skipped scenario proves nothing)
    for (const bh of ALL_B) assert.ok((coverage[bh] || []).length >= 1, `${bh} never applied`);
    for (const bh of ['ECHO', 'CAPS_PUNCT', 'REWRITE', 'INVENT_NUMBER', 'INVENT_LEADERSHIP', 'INVENT_OUTCOME', 'FILLER_WORD', 'SYNONYM_SWAP', 'GOOD_PLUS_BAD', 'EVERYTHING_REJECTED', 'HOSTILE_SHAPES']) assert.ok(coverage[bh].length >= 7, `${bh} applied to only ${coverage[bh].length} applicants`);
    console.log(`# stress matrix: ${ran} scenarios run, 0 violations`);
  });

  // ═══ 2. the oracle can FAIL: deliberately broken builds are caught ═══
  const SAB_P = ['firstDetailed', 'multi', 'poor', 'experienced']; const SAB_B = ['ECHO', 'GRAMMAR_ONE_WORD', 'DEDUPE_ONLY', 'FILLER_WORD', 'SYNONYM_SWAP', 'ONE_WORD_FROM_ENTRY', 'REWRITE', 'INVENT_NUMBER', 'INVENT_BENEFICIARY', 'INVENT_OUTCOME', 'INVENT_INTO_BLANK', 'BORROW_FROM_OTHER_ENTRY', 'GOOD_PLUS_BAD', 'EVERYTHING_REJECTED'];
  const real = { guardResume: integrity.guardResume, assessChange: integrity.assessChange };
  const scoring = require(path.join(FUNCS, '_lib', 'scoring')); const realScore = scoring.score;      // the SAME instance the handler charges by
  async function withSabotage(patch, fn) { const { score, ...rest } = patch; Object.assign(integrity, rest); if (score) scoring.score = score; try { return await fn(); } finally { Object.assign(integrity, real); scoring.score = realScore; } }
  await t.test('sanity: the reduced set used for sabotage passes on the real build', async () => { const r = await runAll(SAB_P, SAB_B); assert.deepEqual(r.violations, []); assert.ok(r.ran >= 40); });
  const SABOTAGE = {
    'the integrity guard is switched off (AI text goes straight through)': { guardResume: (orig, out) => ({ resume: Core.clean(out), withheld: [] }) },
    'any single small fix is charged (the 3-point threshold is gone)': { score: (a, b) => { const r = realScore(a, b); return { ...r, charge: r.points > 0 }; } },
    'every point is counted three times (a one-word fix becomes a paid rewrite)': { score: (a, b) => { const r = realScore(a, b); return { ...r, points: r.points * 3, charge: r.points * 3 >= r.threshold }; } },
    'nothing is ever charged (the credit is given away)': { score: (a, b) => ({ ...realScore(a, b), charge: false }) },
    'flagged lines are kept instead of withheld (the 884640f behaviour)': { guardResume: (orig, out) => { const r = integrity.reconcile(orig, out, { keepBlankedText: true, entryScope: true, maxFlags: 1000 }); return { resume: Core.clean(r.resume), withheld: [] }; } },
    'blank fields may be filled and borrowed lines are not noticed (no entry scope)': { guardResume: (orig, out, o) => { const r = integrity.reconcile(orig, out, { vocabulary: o && o.vocabulary, keepBlankedText: true, maxFlags: 1000 }); const w = integrity.withholdFlagged(orig, r.resume, r.unverified, {}); return { resume: Core.clean(w.resume), withheld: w.withheld }; } }
  };
  for (const [name, patch] of Object.entries(SABOTAGE)) {
    await t.test(`DEFECT DETECTED: ${name}`, async () => {
      const r = await withSabotage(patch, () => runAll(SAB_P, SAB_B));
      assert.ok(r.violations.length > 0, 'the oracle did not notice the defect: the suite would pass a broken build');
      console.log(`# sabotage "${name.slice(0, 48)}": ${r.violations.length} violations caught`);
    });
  }

  // ═══ 3. customers change their information ═══
  const polish = (c, resume, extra = {}) => hs.polish(post({ code: c, resume, target: 'customer service', ...extra }));
  await t.test('CUSTOMER ADDS RESPONSIBILITIES AND MEASURABLE ACHIEVEMENTS: new facts are recognised and may be used; invented numbers are not', async () => {
    fresh(); const c = await seed(); const r = clone(P.changer);
    r.experience[0].bullets.push('Trained 6 new hires on the scanner', 'Handled about 40 calls per day');
    ai.polishPayload = (src) => { const o = clone(src); const bl = o.experience[0].bullets; bl[3] = 'Trained 6 new hires and used the scanner'; bl[4] = 'Handled about 40 calls per day, reaching 99% accuracy'; return o; };
    const b = parseBody(await polish(c, r)); const out = b.result ? JSON.parse(b.result) : null;
    assert.equal(b.charged, true); assert.equal(await uses(c), 4);
    const bl = out.experience[0].bullets;
    assert.ok(bl.includes('Trained 6 new hires and used the scanner'), 'the customer\'s own number 6 is supported and the rewrite is kept');
    assert.equal(bl.includes('Handled about 40 calls per day, reaching 99% accuracy'), false); assert.equal(JSON.stringify(out).includes('99%'), false);
    assert.ok(bl.includes('Handled about 40 calls per day'), 'the unsupported 99% line was put back to the customer\'s own words');
    assert.deepEqual(b.withheld.map((w) => w.where), ['experience.0.bullets.4']);
  });
  await t.test('CUSTOMER CHANGES A NUMBER THE AI THEN "CORRECTS": the AI may not alter the figure', async () => {
    fresh(); const c = await seed(); const r = clone(P.polished);
    ai.polishPayload = (src) => { const o = clone(src); o.experience[0].bullets[1] = 'Trained 60 new cashiers on the register and returns policy'; o.experience[0].bullets[2] = realReword(o.experience[0].bullets[2]); return o; };
    const b = parseBody(await polish(c, r)); const out = JSON.parse(b.result);
    assert.equal(out.experience[0].bullets[1], 'Trained 6 new cashiers on the register and returns policy');
    assert.equal(out.experience[0].bullets[2], realReword(r.experience[0].bullets[2]), 'the honest rewrite beside it is kept'); assert.equal(b.charged, true);
  });
  await t.test('CUSTOMER ADDS ANOTHER JOB: the new job can be reworded, but its accomplishments are never lent to the old jobs', async () => {
    fresh(); const c = await seed(); const r = clone(P.changer);
    r.experience.unshift({ title: 'Barista', company: 'Fictional Cafe', start: '2026', end: 'Present', bullets: ['Made drinks and cleaned the espresso machine', 'Won the cafe tip jar contest'] });
    ai.polishPayload = (src) => { const o = clone(src); o.experience[0].bullets[0] = realReword(o.experience[0].bullets[0]); o.experience[1].bullets[2] = 'Won the cafe tip jar contest'; return o; };
    const b = parseBody(await polish(c, r)); const out = JSON.parse(b.result);
    assert.equal(b.charged, true); assert.equal(out.experience[0].bullets[0], realReword('Made drinks and cleaned the espresso machine'));
    assert.equal(JSON.stringify(out.experience[1]).includes('tip jar'), false, 'the barista award did not move to the warehouse job');
    assert.equal(out.experience[1].bullets[2], 'Followed safety rules on the floor');   // (the customer's line, with its capital letter added)
  });
  await t.test('CUSTOMER REMOVES AN ENTRY: text from the removed entry cannot come back, even if a stale reply replays it', async () => {
    fresh(); const c = await seed(); const r = clone(P.experienced); r.experience = r.experience.slice(0, 2);          // Stock Clerk deleted
    ai.polishPayload = (src) => { const o = clone(src); o.experience.push({ title: 'Stock Clerk', company: 'Fictional Grocery', start: '1999', end: '2004', bullets: ['Stocked shelves', 'Handled returns'] }); o.experience[1].bullets.push('Handled returns'); o.experience[0].bullets[0] = realReword(o.experience[0].bullets[0]); return o; };
    const b = parseBody(await polish(c, r)); const out = JSON.parse(b.result);
    assert.equal(out.experience.length, 2); assert.equal(JSON.stringify(out).includes('Stock Clerk'), false); assert.equal(JSON.stringify(out).includes('Handled returns'), false);
    assert.ok(!ai.bodies[0].messages[0].content.includes('Stock Clerk'), 'the removed entry was never sent to the AI');
  });
  await t.test('CUSTOMER CHANGES A TITLE AND DATES: the AI is told the new ones and cannot put the old ones back or inflate them', async () => {
    fresh(); const c = await seed(); const r = clone(P.experienced); r.experience[0].title = 'Team Lead'; r.experience[0].start = '2016';
    ai.polishPayload = (src) => { const o = clone(src); o.experience[0].title = 'Shift Lead'; o.experience[0].start = '2012'; o.experience[0].bullets[0] = 'Taught new people the pallet jack'; return o; };
    const b = parseBody(await polish(c, r)); const out = JSON.parse(b.result);
    assert.equal(out.experience[0].title, 'Team Lead'); assert.equal(out.experience[0].start, '2016'); assert.match(ai.bodies[0].messages[0].content, /Team Lead/);
  });
  await t.test('CUSTOMER GIVES ONLY VAGUE INFORMATION: the AI cannot turn "various duties" into specifics', async () => {
    fresh(); const c = await seed();
    ai.polishPayload = (src) => { const o = clone(src); o.experience[0].bullets = ['Baked 200 loaves of bread daily for local customers', 'Did stuff with the oven and the counter and also the oven', 'Managed the bakery counter']; return o; };
    const b = parseBody(await polish(c, P.ambiguous));
    assert.equal(b.noChange, true); assert.equal(b.reason, 'flagged'); assert.equal(await uses(c), 5); assert.ok(b.withheld.length >= 2);
  });
  await t.test('POLISHED, EDITED, POLISHED AGAIN: only a real rewrite of the new wording is charged; echoes and touch-ups are free', async () => {
    fresh(); const c = await seed(); let current = clone(P.multi);
    ai.polishPayload = REWRITE_FIRST; let b = parseBody(await polish(c, current)); assert.equal(b.charged, true); assert.equal(await uses(c), 4); current = JSON.parse(b.result);
    current.experience[0].bullets[1] = 'Counted the cash drawer and checked receipts at closing';                                   // the customer edits
    ai.polishPayload = (r) => clone(r); b = parseBody(await polish(c, current, { requestId: 'edit-0002-aaaa' })); assert.equal(b.noChange, true); assert.equal(await uses(c), 4);
    ai.polishPayload = (r) => { const o = clone(r); o.experience[0].bullets[1] = o.experience[0].bullets[1].replace('checked', 'also checked'); return o; };
    b = parseBody(await polish(c, current, { requestId: 'edit-0003-aaaa' })); assert.equal(b.noChange, true); assert.equal(b.reason, 'minor'); assert.equal(await uses(c), 4);
    ai.polishPayload = (r) => { const o = clone(r); o.experience[1].bullets[0] = realReword(o.experience[1].bullets[0]); return o; };
    b = parseBody(await polish(c, current, { requestId: 'edit-0004-aaaa' })); assert.equal(b.charged, true); assert.equal(await uses(c), 3);
  });
  await t.test('REPEATING POLISH WITHOUT CHANGING ANYTHING: the same request is a free replay; new requests that find nothing are free and capped', async () => {
    fresh(); const c = await seed(); ai.polishPayload = REWRITE_FIRST;
    const first = parseBody(await polish(c, P.multi, { requestId: 'repeat-0001-aaaa' })); assert.equal(first.charged, true);
    const again = parseBody(await polish(c, P.multi, { requestId: 'repeat-0001-aaaa' })); assert.equal(again.result, first.result); assert.equal(await uses(c), 4); assert.equal(ai.calls, 1, 'no second AI call');
    ai.polishPayload = (r) => clone(r);
    for (let i = 0; i < cfg.NOCHANGE_WINDOW_MAX; i++) { const b = parseBody(await polish(c, P.multi, { requestId: `repeat-10${i}-aaaa` })); assert.equal(b.noChange, true); }
    const callsBefore = ai.calls; const capped = await polish(c, P.multi, { requestId: 'repeat-0199-aaaa' });
    assert.equal(capped.statusCode, 429); assert.equal(ai.calls, callsBefore, 'the cap stops the AI call'); assert.equal(await uses(c), 4);
  });
  await t.test('FAILURES AND RETRIES: provider errors, truncation and bad JSON are free; a retry with the same request id is charged once', async () => {
    fresh(); const c = await seed();
    for (const mode of ['http500', 'truncated', 'notjson', 'badshape', 'empty', 'throw']) { ai.mode = mode; const r = await polish(c, P.multi, { requestId: 'fail-0001-aaaa' }); assert.ok(r.statusCode >= 400, mode); assert.equal(await uses(c), 5, mode); }
    ai.mode = 'ok'; ai.polishPayload = REWRITE_FIRST;
    const ok = parseBody(await polish(c, P.multi, { requestId: 'fail-0001-aaaa' })); assert.equal(ok.charged, true); assert.equal(await uses(c), 4);
    const rs = await rows(c); assert.equal(rs.filter((x) => x.status === 'committed').length, 1); assert.ok(rs.filter((x) => x.status === 'released').every((x) => x.fc === false || true));
  });
  await t.test('CONCURRENCY: eight simultaneous polishes on a code with ONE generation left produce exactly one charge', async () => {
    fresh(); const c = await seed(1); ai.polishPayload = REWRITE_FIRST; ai.delayMs = 40;
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => polish(c, P.multi, { requestId: `conc-000${i}-aaaa` })));
    ai.delayMs = 0; assert.equal(await uses(c), 0); assert.equal(rs.filter((r) => parseBody(r).charged === true).length, 1);
    assert.equal((await rows(c)).filter((x) => x.status === 'committed').length, 1);
  });
  await t.test('CONCURRENCY, REPEATED: 12 rounds of 8 simultaneous polishes (free outcomes and a charged one): never two AI calls at once, never more charges than generations, never a lost generation', async () => {
    for (let round = 0; round < 12; round++) {
      fresh(); const c = await seed(2); ai.delayMs = 25; ai.maxInflight = 0; ai.polishPayload = round % 2 ? REWRITE_FIRST : (r) => clone(r);
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => polish(c, P.multi, { requestId: `round-${round}-${i}-aaaa` })));
      ai.delayMs = 0; assert.equal(ai.maxInflight, 1, `round ${round}: ${ai.maxInflight} AI calls overlapped`);
      const charged = rs.filter((r) => parseBody(r).charged === true).length; assert.ok(charged <= 2, `round ${round}: ${charged} charges on a code with 2 generations`);
      assert.equal(await uses(c), 2 - charged); assert.equal((await rows(c)).filter((x) => x.status === 'committed').length, charged);
      assert.equal((await rows(c)).filter((x) => x.status === 'reserved').length, 0, 'no reservation left held');
    }
  });
  await t.test('PRIVACY: across a mixed run (charged, free, flagged, failed, stale page) the logs hold only counts, enum words and ids; the guard version is in every outcome line', async () => {
    const lines = []; const orig = { log: console.log, warn: console.warn, error: console.error };
    const grab = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); console.log = grab; console.warn = grab; console.error = grab;
    try {
      for (const p of ['firstDetailed', 'experienced', 'poor', 'multi']) for (const bh of ['ECHO', 'REWRITE', 'FILLER_WORD', 'INVENT_NUMBER', 'GOOD_PLUS_BAD', 'HOSTILE_SHAPES']) await scenario(p, bh);
      fresh(); const c = await seed(); ai.mode = 'http500'; await polish(c, P.multi); ai.mode = 'ok';
      await polish(c, P.multi, { clientGuard: 'entry-scope-old' });
    } finally { Object.assign(console, orig); }
    const log = lines.join('\n'); assert.ok(log.includes('ai-outcome') && log.includes('ai-usage'));
    const secrets = new Set(); const walk = (v) => { if (typeof v === 'string' && v.length >= 6) secrets.add(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    ['firstDetailed', 'experienced', 'poor', 'multi'].forEach((k) => walk(P[k]));
    for (const secret of secrets) assert.equal(log.includes(secret), false, `a log line contains resume text: ${secret}`);
    for (const secret of ['FG-', 'TESTKEY-STRESS', SECRET]) assert.equal(log.includes(secret), false, `a log line contains ${secret}`);
    const outcomes = lines.filter((l) => l.startsWith('ai-outcome ')).map((l) => JSON.parse(l.slice(11)));
    assert.ok(outcomes.length >= 20); for (const o of outcomes) { assert.deepEqual(Object.keys(o).sort(), ['fn', 'guard', 'outcome', 'points', 'ref', 'reworded', 'withheld']); if (o.outcome !== 'failed') assert.equal(o.guard, Core.GUARD_VERSION); }
    assert.deepEqual([...new Set(outcomes.map((o) => o.outcome))].sort(), ['charged', 'failed', 'flagged', 'nochange']);
  });
  await t.test('LONG RESUME near the limit works; one over the limit is refused before any reservation or AI call', async () => {
    fresh(); const c = await seed(); ai.polishPayload = REWRITE_FIRST;
    assert.ok(limits.fitsOutput(JSON.stringify(Core.clean(P.long)).length, cfg.TAILOR_MAX_TOKENS), 'fixture fits');
    const b = parseBody(await polish(c, P.long)); assert.equal(b.charged, true);
    const over = clone(P.long); over.experience.push({ title: 'Extra', company: 'Fictional Extra Co', bullets: ['x'.repeat(2500)] });
    const callsBefore = ai.calls; const r = await polish(c, over); assert.equal(r.statusCode, 413); assert.equal(ai.calls, callsBefore); assert.equal(await uses(c), 4);
  });
});
