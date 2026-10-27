// Guided resume builder: plain-English questions for people with no resume yet.
// It writes straight into state.data (the same object Edit Fields and the preview use), so there is one
// source of truth: nothing to sync, every step can be revisited, and "Edit Fields" always shows the same data.
// It is entirely manual: no AI call, no license debit, no network request.
// Relies on globals from index.html: state, esc, updateField, updateArrayItem, renderPreview, renderEditFields,
// switchPanel, syncChrome, selectTemplate, showGate, pendingGeneration, ResumeCore.

// Product decision (owner can flip): building by hand needs a verified access code, like the paid tools do.
// Verifying a code is read-only and never uses up a generation. false = open to everyone (changes customer access).
const WIZARD_REQUIRES_LICENSE = true;

const WIZ_STEPS = [
  { id: 'goal', label: 'Goal' },
  { id: 'contact', label: 'You' },
  { id: 'work', label: 'Work' },
  { id: 'education', label: 'School' },
  { id: 'extras', label: 'Projects & more' },
  { id: 'skills', label: 'Skills' },
  { id: 'review', label: 'Review' }
];

// Things a worker can tick if (and only if) they are true. A tick adds that exact line; unticking removes it.
const WIZ_DUTY_CHECKS = [
  'Helped customers and answered their questions',
  'Handled cash and card payments',
  'Followed safety rules and procedures',
  'Kept accurate records and paperwork',
  'Showed new coworkers how to do their tasks',
  'Worked with a team to get daily work done',
  'Solved problems when something went wrong',
  'Opened or closed the workplace',
  'Used equipment and tools safely',
  'Supervised or led other workers (only if you really did)'
];

const WIZ_SKILLS = [
  'Customer service', 'Teamwork', 'Clear communication', 'Dependable and on time', 'Quick learner', 'Problem solving',
  'Cash handling', 'Data entry', 'Basic computer skills', 'Following safety rules', 'Keeping records organized', 'Working under pressure'
];

// Education is asked as separate things (what qualification, what subject, finished or still studying) and stored in the
// same fields the editor and exports already use: degree = "Associate degree in Nursing", date = "2026" or "Expected 2027".
const WIZ_QUALS = ['High school diploma', 'GED', 'Some college', 'Certificate', 'Associate degree', 'Bachelor’s degree', 'Master’s degree', 'Doctorate'];
const WIZ_NO_SUBJECT = ['High school diploma', 'GED'];

function composeEdu(m) {
  const q = (m.qual === 'Other' ? m.other : m.qual || '').trim();
  const f = WIZ_NO_SUBJECT.includes(m.qual) ? '' : (m.field || '').trim();
  const degree = q && f ? `${q} in ${f}` : q || f;
  const y = (m.year || '').trim();
  const date = m.status === 'ongoing' ? (y ? `Expected ${y}` : 'In progress') : y;
  return { degree, date };
}

// Read an existing entry (typed in the editor, pasted, or written by the AI) back into the question fields.
function parseEdu(e) {
  const d = String((e && e.degree) || '').trim();
  const dt = String((e && e.date) || '').trim();
  const m = { qual: '', other: '', field: '', status: /^(expected|in progress)/i.test(dt) ? 'ongoing' : 'done', year: dt.replace(/^expected\s*/i, '').replace(/^in progress$/i, '').trim() };
  if (!d) return m;
  const q = WIZ_QUALS.find(x => d.toLowerCase().startsWith(x.toLowerCase()));
  const rest = q ? d.slice(q.length) : '';
  if (q && (rest.trim() === '' || /^\s+in\s+/i.test(rest))) { m.qual = q; m.field = rest.replace(/^\s+in\s+/i, '').trim(); return m; }
  m.qual = 'Other'; m.other = d;
  return m;
}

const Wiz = {
  // ── lifecycle ──────────────────────────────────────────────────────────────
  start(path) {
    if (state.aiBusy) return;
    if (WIZARD_REQUIRES_LICENSE && !state.license.verified) {
      pendingGeneration = () => Wiz.start(path);
      showGate('Enter your access code to start building. Building your resume by hand never uses one of your generations.');
      return;
    }
    if (state.data && ResumeCore.hasContent(state.data) && !confirm('This will replace the resume currently in the editor. Start a new one?')) return;
    state.data = ResumeCore.blank();
    state.flags = new Set(); state.preTailor = null; state.polishOriginal = null; state.polishResult = null; state.polishBaseline = null;
    state.polish = null;
    const note = document.getElementById('analyze-notice'); if (note) note.innerHTML = '';
    state.wizard = { path, step: 0, work: null, target: '', autoTagline: '', profile: path === 'first' ? 'first' : 'experienced', edu: [] };
    if (state.selectedTemplate.id === 'boardroom') selectTemplate('partner');   // plainest default; customers can change it
    Wiz.render();
    switchPanel('guide');
    renderEditFields();
    renderPreview();
  },

  busy() { return !!(state.polish && state.polish.busy); },   // a paid polish is running: stay put
  go(i) { if (Wiz.busy()) return; Wiz.applyTarget(); state.wizard.step = Math.max(0, Math.min(WIZ_STEPS.length - 1, i)); Wiz.render(); document.getElementById('panel-guide').scrollTop = 0; },
  next() { if (Wiz.busy()) return; if (state.wizard.step >= WIZ_STEPS.length - 1) return Wiz.finish(); Wiz.go(state.wizard.step + 1); },
  back() { if (Wiz.busy()) return; Wiz.go(state.wizard.step - 1); },
  finish() { renderEditFields(); switchPanel('edit'); document.getElementById('panel-edit').scrollTop = 0; renderEditPolish(); const card = document.getElementById('edit-polish'); if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest' }); },   // start at the top, where AI polish is offered (and on screen even if the page itself was scrolled to reach this button)

  // ── small data helpers (all write to state.data) ───────────────────────────
  set(path, v) { updateField(path, v); },
  item(arr, i, field, v) { updateArrayItem(arr, i, field, v); },
  lines(arr, i, v) { state.data[arr][i].bullets = v.split('\n').map(x => x.trim()).filter(Boolean); renderPreview(); },
  add(arr, tpl) { arrayAt(arr).push(tpl); Wiz.render(); renderPreview(); },
  remove(arr, i) { arrayAt(arr).splice(i, 1); if (arr === 'education' && state.wizard.edu) state.wizard.edu.splice(i, 1); Wiz.render(); renderPreview(); },
  addRoleSameEmployer(i) {
    const e = state.data.experience[i];
    state.data.experience.splice(i + 1, 0, { title: '', company: e.company, location: e.location, start: '', end: '', summary: '', bullets: [] });
    Wiz.render(); renderPreview();
  },
  tick(arr, i, idx, on) {
    const line = WIZ_DUTY_CHECKS[idx];
    const b = state.data[arr][i].bullets = state.data[arr][i].bullets || [];
    const at = b.indexOf(line);
    if (on && at < 0) b.push(line);
    if (!on && at >= 0) b.splice(at, 1);
    const ta = document.getElementById(`wiz-lines-${arr}-${i}`);
    if (ta) ta.value = b.join('\n');
    renderPreview();
  },
  current(i, on) { state.data.experience[i].end = on ? 'Present' : ''; Wiz.render(); renderPreview(); },
  chooseWork(v) {
    state.wizard.work = v;
    if (v !== 'no' && !state.data.experience.length) state.data.experience.push({ title: '', company: '', location: '', start: '', end: '', summary: '', bullets: [] });
    Wiz.render(); renderPreview();
  },
  // "Work you're looking for" fills the one-line intro, but only while the intro is empty or still our own fill (a customer's edit is never
  // overwritten). Typing is applied after a short pause so a half-typed word never becomes a half-sentence; a paste, a keyboard
  // suggestion, a clear, leaving the field or pressing Next applies at once. The intro field itself stays independently editable.
  setTarget(v, ev) {
    const w = state.wizard; const prev = w.target || ''; w.target = v;
    clearTimeout(w.targetTimer);
    // Keystrokes change the text by one character; a paste, a replaced word, a cleared box or a filled-in value changes it by more.
    const typing = ev && /^(insertText|insertCompositionText|deleteContent|deleteWord|deleteSoft|deleteHard)/.test(ev.inputType || '') && Math.abs(v.length - prev.length) <= 1;
    if (typing && v.trim()) { w.targetTimer = setTimeout(() => Wiz.applyTarget(), 700); return; }
    Wiz.applyTarget();
  },
  applyTarget() {
    const w = state.wizard; if (!w) return;
    clearTimeout(w.targetTimer);
    const t = state.data.summary.tagline;
    if (t && t !== w.autoTagline) return;                       // the customer wrote or changed it: leave it alone
    const next = ResumeCore.introFromTarget(w.target);
    if (next === t) { w.autoTagline = next; return; }
    w.autoTagline = next;
    state.data.summary.tagline = next;
    const el = document.getElementById('wiz-tagline'); if (el) el.value = next;
    renderPreview();
  },
  addSinceLine(i) {
    const e = state.data.experience[i];
    const y = ResumeCore.sinceYear(e.start);
    if (!y || !e.company) return;
    const line = `Working at ${e.company} since ${y}`;
    if (!state.data.summary.bullets.includes(line)) state.data.summary.bullets.push(line);
    Wiz.render(); renderPreview();
  },
  // Education question model: one entry per school, kept beside the data and re-read if the entry was edited elsewhere.
  eduModel(i) {
    const w = state.wizard; w.edu = w.edu || [];
    const e = state.data.education[i] || {};
    const c = w.edu[i] && composeEdu(w.edu[i]);
    if (c && c.degree === String(e.degree || '') && c.date === String(e.date || '')) return w.edu[i];
    return (w.edu[i] = parseEdu(e));
  },
  eduSet(i, key, v) {
    const m = Wiz.eduModel(i); m[key] = v;
    if (key === 'qual' && WIZ_NO_SUBJECT.includes(v)) m.field = '';
    const c = composeEdu(m);
    updateArrayItem('education', i, 'degree', c.degree); updateArrayItem('education', i, 'date', c.date);
    if (key === 'qual' || key === 'status') Wiz.render();              // these change which questions are shown
  },
  setProfile(v) { state.wizard.profile = v; Wiz.render(); },
  toggleSkill(name, on) {
    const s = state.data.summary.skills;
    const at = s.indexOf(name);
    if (on && at < 0) s.push(name);
    if (!on && at >= 0) s.splice(at, 1);
    renderPreview();
  },
  setCustomSkills(v) {
    const picked = state.data.summary.skills.filter(x => WIZ_SKILLS.includes(x));
    const extra = v.split(',').map(x => x.trim()).filter(Boolean).filter(x => !picked.includes(x));
    state.data.summary.skills = picked.concat(extra);
    renderPreview();
  },

  // ── AI polish (paid: exactly ONE of the code's included generations per successful polish) ──────────────
  // Nothing here runs on navigation, typing or preview. A charge needs two deliberate clicks: the button, then
  // an explicit confirmation that states the cost. The server charges only after a validated result.
  polishState() { return state.polish || (state.polish = { confirm: false, busy: false, requestId: null, msg: '', kind: '', done: null, noChange: null }); },
  // One attempt, one outcome: the card shows exactly ONE of improved (p.done), no meaningful improvement (p.noChange) or an error
  // (p.msg), and starting a new attempt clears whatever the last one left behind. Every result goes through here.
  setOutcome(type, data) {
    const p = Wiz.polishState();
    p.done = type === 'improved' ? (data || {}) : null;
    p.noChange = type === 'nochange' ? { reason: ['flagged', 'minor', 'sparse'].includes(data && data.reason) ? data.reason : 'unchanged', withheld: Array.isArray(data && data.withheld) ? data.withheld : [] } : null;
    p.msg = type === 'error' ? data : ''; p.kind = type === 'error' ? 'err' : '';
  },
  // Polish is offered both on the Review step and at the top of the regular editor; both views read the same state.
  refreshPolish() { if (state.wizard) Wiz.render(); renderEditPolish(); },
  askPolish() { const p = Wiz.polishState(); if (p.busy) return; p.confirm = true; p.msg = ''; p.noChange = null; Wiz.refreshPolish(); },
  cancelPolish() { const p = Wiz.polishState(); p.confirm = false; Wiz.refreshPolish(); },
  newRequestId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  },

  async doPolish() {
    const w = state.wizard || {}; const p = Wiz.polishState();
    if (p.busy) return;                                                    // double-click: one request only
    if (!state.license.verified || !state.license.code) { showGate('Enter your access code to use AI polish.'); return; }
    if (!ResumeCore.hasWritableText(ResumeCore.clean(state.data))) return;
    if (state.aiBusy) { p.confirm = false; Wiz.setOutcome('error', AI_BUSY_TEXT); Wiz.refreshPolish(); return; }
    p.busy = true; p.confirm = false; Wiz.setOutcome(null);                // forget the previous attempt's result
    aiBegin('polish');                                                     // freezes the fields and the other AI buttons until this finishes
    if (!p.requestId) p.requestId = Wiz.newRequestId();                     // reused on a manual retry (even after a reload), so a lost reply is never charged twice
    state.pending = { fn: 'polish', requestId: p.requestId, at: Date.now() }; saveWork();     // survives a reload while the AI is working
    let definite = false;                                                  // true once the server has given a definite answer
    Wiz.refreshPolish();
    try {
      const res = await aiFetch('/.netlify/functions/polish-resume', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: state.license.code, resume: state.data, target: w.target || '', profile: w.profile || undefined, requestId: p.requestId, expectIncluded: hasIncluded(), clientGuard: ResumeCore.GUARD_VERSION })
      });
      let json = null; try { json = await res.json(); } catch (e) { /* non-JSON gateway error */ }
      definite = json !== null && (res.status !== 409 || json.newRequest === true) && res.status < 500;  // a cut-off body, 409 (busy) or a server error may mean the answer was lost: keep the id. A refusal asking for a NEW request ends this id
      let parsed = null;
      if (res.ok && json && json.result && json.noChange !== true) { try { parsed = JSON.parse(json.result); } catch (e) { parsed = null; } }
      if (res.ok && json && json.noChange === true) {
        // Nothing meaningful to improve: the server released the reservation (no charge). Leave the resume, flags and
        // tailoring token exactly as they were. This is a success, not a failure: it must never reach polishFailed.
        if (typeof json.usesRemaining === 'number') state.license.usesRemaining = json.usesRemaining;
        if (typeof json.maxUses === 'number') state.license.maxUses = json.maxUses;
        p.requestId = null; Wiz.setOutcome('nochange', { reason: json.reason, withheld: json.withheld });
        renderLicenseBadge();
      } else if (parsed) {
        if (!state.polishBaseline) state.polishBaseline = ResumeCore.clean(state.data);   // the customer's own words before ANY polish (a second polish must not lose them)
        state.polishOriginal = ResumeCore.clean(state.data);               // the wording from before THIS polish, for Restore
        state.data = parsed;
        state.polishResult = JSON.parse(JSON.stringify(ResumeCore.clean(parsed)));   // what the polish returned, to tell later whether the customer edited it
        if (json.charged !== false) state.tailorToken = json.tailorToken || null;     // a free (small-fix) result has no paid generation behind it: an earlier paid token stays valid
        else if (json.included && json.tailorToken) state.tailorToken = json.tailorToken;   // an included Polish re-signs its PARENT Analyze: same Tailor runs, a fresh 2-hour window
        if (typeof json.usesRemaining === 'number') state.license.usesRemaining = json.usesRemaining;
        if (typeof json.maxUses === 'number') state.license.maxUses = json.maxUses;
        const unverified = Array.isArray(json.unverified) ? json.unverified : [];
        state.flags = new Set(unverified.map(u => String(u.text || '').trim()).filter(Boolean));
        state.preTailor = null;
        p.requestId = null;
        if (json.charged !== false || json.included) rememberReceived(json.supportRef);          // this device has the result: the "restore" offer will not show it again
        if (json.included) state.license.includedAvailable = Math.max(0, (state.license.includedAvailable || 0) - 1);
        Wiz.setOutcome('improved', { recovered: json.recovered || null, recoveredMessage: json.message || '', supportRef: json.supportRef || '', included: json.included === true, free: json.charged === false && json.included !== true, unverified, withheld: Array.isArray(json.withheld) ? json.withheld : [], changes: json.changes && typeof json.changes === 'object' ? json.changes : null });
        renderLicenseBadge(); renderEditFields(); renderPreview();
        refreshLicenseCounter({ accessOnly: true });                        // the included Polish count and access state after this step
      } else {
        await Wiz.polishFailed(res.status, json);
      }
    } catch (e) {
      // The request may or may not have finished. Keep the request id so a manual retry cannot be charged twice.
      Wiz.setOutcome('error', 'We couldn’t confirm whether that finished. Your resume is unchanged. Please check the generations counter above, then try again.');
      refreshLicenseCounter();
    } finally {
      p.busy = false;
      if (definite) state.pending = null;
      aiEnd('polish');
      Wiz.refreshPolish();
      saveWork();
    }
  },

  async polishFailed(status, json) {
    const p = Wiz.polishState();
    const message = (json && json.error) || 'Something went wrong while polishing. You haven’t been charged. Please try again.';
    Wiz.setOutcome('error', message);
    if (status === 401 || (status === 403 && !(json && json.usesRemaining === 0))) {
      state.license = { code: null, verified: false, usesRemaining: null, maxUses: null };
      store.remove(LICENSE_STORAGE_KEY);
      renderLicenseBadge(); showGate(message); p.requestId = null; return;
    }
    if (status === 403) {                                                   // all generations used
      state.license.usesRemaining = 0;
      if (typeof json.maxUses === 'number') state.license.maxUses = json.maxUses;
      renderLicenseBadge(); p.requestId = null; return;
    }
    if (json && json.newRequest === true) { p.requestId = null; await refreshLicenseCounter(); return; }   // spent on other input, too old, or out of recoveries: the next press is a deliberate NEW request
    if (json && json.code === 'recovery_failed') { await refreshLicenseCounter(); return; }                // the paid step is still waiting to be recovered: keep the id for the retry
    if (status === 409) return;                                             // something is already running: keep the id
    p.requestId = null;                                                     // a definite, uncharged failure: next try is a fresh request
    await refreshLicenseCounter();
  },

  // Which entry of `list` is the same one as `e` (same job title and company, project name, ...)? The position is tried first, then a
  // unique match elsewhere. Restore uses this so that deleting, adding or re-ordering entries after a polish can never put one entry's
  // wording into another.
  ENTRY_ID: { experience: ['title', 'company'], projects: ['name'], volunteer: ['title', 'organization'] },
  idOf(kind, e) { return (Wiz.ENTRY_ID[kind] || []).map(f => String((e && e[f]) || '').trim().toLowerCase()).join('|'); },
  sameEntry(list, kind, e, i, mine) {
    if (!Array.isArray(list)) return null;
    const id = Wiz.idOf(kind, e);
    if (list[i] && Wiz.idOf(kind, list[i]) === id) return list[i];
    const hits = list.filter(x => Wiz.idOf(kind, x) === id);
    return hits.length === 1 && mine.filter(x => Wiz.idOf(kind, x) === id).length === 1 ? hits[0] : null;
  },
  partOf(e) { return JSON.stringify([e.bullets || [], e.summary || '', e.description || '']); },

  // Which parts of the resume did the AI reword? (compared with the customer's own wording)
  changedParts() {
    const o = state.polishOriginal; if (!o) return [];
    const d = ResumeCore.clean(state.data);
    const out = [];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (!same([o.summary.tagline, o.summary.bullets, o.summary.skills], [d.summary.tagline, d.summary.bullets, d.summary.skills])) out.push({ kind: 'summary', i: 0, label: 'Headline and summary' });
    [['experience', 'title', 'Job'], ['projects', 'name', 'Project'], ['volunteer', 'title', 'Activity']].forEach(([k, f, name]) => {
      d[k].forEach((e, i) => {
        const before = Wiz.sameEntry(o[k], k, e, i, d[k]); if (!before) return;
        if (Wiz.partOf(before) !== Wiz.partOf(e)) out.push({ kind: k, i, label: `${name}: ${e[f] || before[f] || i + 1}` });
      });
    });
    return out;
  },
  // Has the customer changed this since the polish returned it? Restoring would then throw their newer edits away, so ask first.
  editedSincePolish(kind, i) {
    const r = state.polishResult; if (!r) return false;
    if (kind === 'summary') return JSON.stringify(ResumeCore.clean(state.data).summary) !== JSON.stringify(ResumeCore.clean(r).summary);
    const mine = ResumeCore.clean(state.data)[kind]; const e = mine[i]; if (!e) return false;
    const was = Wiz.sameEntry(ResumeCore.clean(r)[kind], kind, e, i, mine);
    return !was || Wiz.partOf(was) !== Wiz.partOf(e);
  },
  restorePart(kind, i) {
    const o = state.polishOriginal; if (!o || state.aiBusy) return;
    if (Wiz.editedSincePolish(kind, i) && !confirm('You have changed this part since the polish. Restoring puts back your wording from before the polish and replaces those newer changes. Continue?')) return;
    if (kind === 'summary') state.data.summary = JSON.parse(JSON.stringify(o.summary));
    else {
      const cur = state.data[kind] && state.data[kind][i]; if (!cur) return;
      const before = Wiz.sameEntry(o[kind], kind, cur, i, state.data[kind]);
      if (!before) return;                                                // not the same entry any more: never guess
      ['bullets', 'summary', 'description'].forEach(f => { if (f in before) cur[f] = JSON.parse(JSON.stringify(before[f])); });
    }
    const lines = new Set();                                              // keep only flags whose line is still in the resume
    (function walk(v) { if (typeof v === 'string') lines.add(v.trim()); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(state.data);
    state.flags = new Set([...state.flags].filter(t => lines.has(t)));
    renderEditFields(); renderPreview(); Wiz.refreshPolish();
  },
  restoreAll() {
    if (!state.polishOriginal || state.aiBusy) return;
    const r = state.polishResult;
    const edited = r && JSON.stringify(ResumeCore.clean(state.data)) !== JSON.stringify(ResumeCore.clean(r));
    if (edited && !confirm('You have changed your resume since the polish (by editing it or tailoring it). Restoring puts back your original wording from before the polish and replaces everything now in the editor. Continue?')) return;
    state.data = JSON.parse(JSON.stringify(state.polishOriginal));
    if (JSON.stringify(state.polishBaseline) === JSON.stringify(state.polishOriginal)) state.polishBaseline = null;     // nothing earlier is left to go back to
    state.polishOriginal = null; state.polishResult = null; state.flags = new Set(); Wiz.polishState().done = null;
    // A tailoring run belongs to the resume that was just replaced: its Undo and its notes no longer apply.
    state.preTailor = null; const box = document.getElementById('match-summary-box'); if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    renderEditFields(); renderPreview(); Wiz.refreshPolish();
  },

  // After two or more polishes "Restore all my original wording" goes back to before the LAST polish. This goes back to what the customer wrote
  // before the FIRST one, which is otherwise unrecoverable.
  hasEarlierWording() { const b = JSON.stringify(state.polishBaseline); return !!state.polishBaseline && !!state.data && b !== JSON.stringify(ResumeCore.clean(state.data)) && b !== JSON.stringify(state.polishOriginal); },
  restoreBaseline() {
    if (!Wiz.hasEarlierWording() || state.aiBusy) return;
    if (!confirm('This puts back exactly what you wrote before the first AI polish and replaces everything now in the editor, including later edits and polishes. Continue?')) return;
    state.data = JSON.parse(JSON.stringify(state.polishBaseline));
    state.polishBaseline = null; state.polishOriginal = null; state.polishResult = null; state.flags = new Set(); Wiz.polishState().done = null;
    state.preTailor = null; const box = document.getElementById('match-summary-box'); if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    renderEditFields(); renderPreview(); Wiz.refreshPolish();
  },

  polishBlock(prefix = '', compact = false) {
    const p = Wiz.polishState();
    const left = state.license.usesRemaining, max = state.license.maxUses;
    const writable = ResumeCore.hasWritableText(ResumeCore.clean(state.data));
    const plural = (n) => `${n} generation${n === 1 ? '' : 's'}`;
    const credit = hasIncluded();                                                // an unused included Polish: this Polish uses no generation, even at zero left
    const lastStep = credit && left === 0 && (Number(state.license.includedAvailable) || 0) === 1;      // using it is the customer's last AI step: the four-day finishing period follows
    const keepNote = 'If you restore your own wording afterwards, it stays used. A second meaningful polish uses another generation.';
    let body;
    if (p.busy) {
      body = '<div class="loading-indicator"><div class="spinner"></div>Polishing your resume… this can take up to a minute. Please keep this page open.</div>';
    } else if (state.aiBusy) {
      body = '<div class="wiz-example">Another AI step is running. You can polish when it has finished.</div>';
    } else if (left === 0 && !credit) {
      body = `<div class="wiz-err">You’ve used all ${max || 5} generations on this code.${etsyLinkHTML()} Your resume is still fully editable and downloadable.</div>`;
    } else if (!writable) {
      body = '<div class="wiz-example">Add a few answers first (what you did in a job, a project, or your skills), then come back.</div>';
    } else if (p.confirm && credit) {
      body = `<div class="wiz-confirm"><strong>The AI will review your resume and fix what it can, using only what you wrote. Your included polish is used only if it rewrites some of your wording or corrects three or more mistakes.</strong>
          If it does, no generation is used. If it finds fewer than that, it still applies the small fixes it found, and nothing is used. Anything that adds details not in your answers is left out, and if anything goes wrong nothing is used and your wording stays exactly as you wrote it. ${keepNote}${lastStep ? ' This is your last AI step: you will then have four days to finish editing and download your resume.' : ''}
          <div><button class="wiz-polish-btn" style="width:auto" onclick="Wiz.doPolish()" id="${prefix}polish-confirm">Yes, polish my resume (included, uses no generation)</button><button class="wiz-back" onclick="Wiz.cancelPolish()">Cancel</button></div></div>`;
    } else if (p.confirm) {
      body = `<div class="wiz-confirm"><strong>The AI will review your resume and fix what it can, using only what you wrote. A generation is used only if it rewrites some of your wording or corrects three or more mistakes.</strong>
          If it does, that uses 1 of your ${typeof left === 'number' ? plural(left) + ' remaining' : 'generations'}. If it finds fewer than that, it still applies the small fixes it found, and no generation is used. Anything that adds details not in your answers is left out, and if anything goes wrong nothing is used and your wording stays exactly as you wrote it. If you restore your own wording afterwards, that generation stays used, and a second meaningful polish uses another generation.
          <div><button class="wiz-polish-btn" style="width:auto" onclick="Wiz.doPolish()" id="${prefix}polish-confirm">Yes, polish my resume (uses 1)</button><button class="wiz-back" onclick="Wiz.cancelPolish()">Cancel</button></div></div>`;
    } else if (credit) {
      body = `<button class="wiz-polish-btn" onclick="Wiz.askPolish()" id="${prefix}polish-btn">✨ Polish My Resume with AI (included)</button>
        <div class="wiz-example">Included with your analysis, so it uses no generation. It is used up only if the AI rewrites some of your wording or corrects three or more mistakes (smaller fixes are applied and nothing is used). Changes that add details not in your answers are always left out. ${keepNote}${lastStep ? ' Using it is your last AI step: you will then have four days to finish editing and download your resume.' : ''} Typing, previewing, editing and downloading never use one.</div>`;
    } else {
      body = `<button class="wiz-polish-btn" onclick="Wiz.askPolish()" id="${prefix}polish-btn">✨ Polish My Resume with AI</button>
        <div class="wiz-example">Uses 1 of your ${typeof left === 'number' ? left : 'remaining'} generation${left === 1 ? '' : 's'}${typeof left === 'number' && max ? ` (of ${max})` : ''} only if the AI rewrites some of your wording or corrects three or more mistakes (smaller fixes are applied free). Changes that add details not in your answers are always left out. If you restore your own wording afterwards, that generation stays used, and a second meaningful polish uses another generation. Typing, previewing, editing and downloading never use one.</div>`;
    }
    let result = '';
    if (p.done && state.polishOriginal) {
      const parts = Wiz.changedParts(); const unv = p.done.unverified || []; const wh = p.done.withheld || [];
      const recNote = p.done.recovered ? `<div class="notice-box" id="${prefix}polish-recovered" role="status"><strong>${p.done.recovered === 'exact' ? 'Your earlier result is back.' : 'Your earlier result was recovered.'}</strong> ${esc(p.done.recoveredMessage || '')}${p.done.supportRef ? ` <span class="support-ref">Reference: ${esc(p.done.supportRef)}</span>` : ''}</div>` : '';
      const used = p.done.recovered ? `No additional generation was used${typeof left === 'number' ? ` (${left} of ${max || 5} left)` : ''}.` : p.done.included ? `That used your included polish, so no generation was used${typeof left === 'number' ? ` (${left} of ${max || 5} left)` : ''}.` : p.done.free ? `No generation was used${typeof left === 'number' ? ` (${left} of ${max || 5} left)` : ''}: these were small fixes, so they are free.` : `That used 1 generation${typeof left === 'number' ? ` (${left} of ${max || 5} left)` : ''}.`;
      if (!parts.length) {                                                // never call it "Polished" when nothing was reworded
        result = `${recNote}<div class="notice-box" id="${prefix}polish-unchanged" role="status"><strong>No wording changes were made.</strong> The AI kept your answers as they were, so your resume is the same as before. ${used} You can still edit anything yourself.</div>`;
      } else {
      const c = p.done.changes || {}; const n = (k) => Number(c[k]) || 0; const lines = (k) => `${n(k)} line${n(k) === 1 ? '' : 's'}`;
      const did = [n('reworded') ? `rewrote ${lines('reworded')}` : '', n('minor') ? `fixed spelling or a word in ${lines('minor')}` : '', n('cosmetic') ? `tidied capitals or punctuation in ${lines('cosmetic')}` : '', n('dropped') ? `combined or removed ${lines('dropped')} that repeated another` : ''].filter(Boolean);
      result = `${recNote}<div class="wiz-ok"><strong>✓ Polished.</strong> ${used} Read it over: it’s your resume, so edit anything.
        <div id="${prefix}polish-save-note" style="margin-top:6px;">Your resume has been updated. Download a copy to keep your work safe.</div>
        ${did.length ? `<div id="${prefix}polish-summary" style="margin-top:6px;"><strong>What changed:</strong> ${esc(did.join('; '))}.</div>` : ''}
        ${parts.length ? `<div style="margin-top:6px;"><strong>AI reworded:</strong>${parts.map(c => `<div class="wiz-review-row"><div>${esc(c.label)}</div><button class="wiz-link" onclick="Wiz.restorePart('${c.kind}', ${c.i})">Restore my wording</button></div>`).join('')}</div>` : ''}
        ${wh.length ? `<div class="notice-box" id="${prefix}polish-withheld"><strong>${wh.length} suggested change${wh.length === 1 ? ' was' : 's were'} left out.</strong> They added details that are not in your answers, so your own wording was kept there.
          <ul style="margin:6px 0 0 16px;">${wh.slice(0, 8).map(w => `<li>${esc(w.label || 'Resume')} <em>(${esc((w.reasons || []).join('; '))})</em></li>`).join('')}</ul></div>` : ''}
        ${unv.length ? `<div class="notice-box"><strong>Please check ${unv.length} line${unv.length === 1 ? '' : 's'}.</strong> The AI added something that wasn’t in your answers (marked yellow in Edit Fields). Keep only what is true.
          <ul style="margin:6px 0 0 16px;">${unv.slice(0, 8).map(u => `<li>${esc(u.text)} <em>(${esc((u.reasons || []).join('; '))})</em></li>`).join('')}</ul></div>` : ''}
        <button class="wiz-link" onclick="Wiz.restoreAll()">Restore all my original wording</button>
        ${p.done.free ? '' : `<div class="wiz-example" id="${prefix}polish-restore-note">Restoring your own wording does not give back ${p.done.included ? 'your included polish' : 'the generation'}.</div>`}</div>`;
      }
    }
    if (p.noChange) {
      const wh = p.noChange.withheld || [];
      const list = wh.length ? `<ul style="margin:6px 0 0 16px;">${wh.slice(0, 8).map(w => `<li>${esc(w.label || 'Resume')} <em>(${esc((w.reasons || []).join('; '))})</em></li>`).join('')}</ul>` : '';
      const usedLine = `<strong>No generation was used</strong>${typeof left === 'number' ? ` (${left} of ${max || 5} left)` : ''}.`;
      result += p.noChange.reason === 'sparse'
        ? `<div class="notice-box" id="${prefix}polish-nochange" role="status"><strong>There isn’t enough detail for the AI to improve yet.</strong> It will not make anything up to fill the gap. Add a few words about what you did in each job or activity (what you worked with, and what you did each day), then try again. ${usedLine}</div>`
        : p.noChange.reason === 'flagged'
        ? `<div class="notice-box" id="${prefix}polish-nochange" role="status"><strong>The AI’s suggestions were not used.</strong> It suggested changes, but they added details that are not in your answers, and what was left was too little to use a generation, so your wording is unchanged. ${usedLine}${list}</div>`
        : `<div class="notice-box" id="${prefix}polish-nochange" role="status"><strong>No meaningful improvements were found.</strong> The AI reviewed your resume and your wording is unchanged, which often means your answers are already clear. ${usedLine} If you add or change some answers, you can try again.</div>`;
    }
    if (state.polishOriginal && !p.done && !p.busy) {                    // an earlier polish is still in the resume: keep Restore reachable
      result += `<div style="margin-top:6px;"><button class="wiz-link" onclick="Wiz.restoreAll()">Restore all my original wording</button></div>`;
    }
    if (Wiz.hasEarlierWording() && !p.busy) {                              // after two polishes the customer's own first wording is still one click away
      result += `<div style="margin-top:6px;"><button class="wiz-link" id="${prefix}restore-first" onclick="Wiz.restoreBaseline()">Restore what I wrote before the first polish</button></div>`;
    }
    const msg = p.msg ? `<div class="${p.kind === 'err' ? 'wiz-err' : 'wiz-ok'}" role="status">${esc(p.msg)}</div>` : '';
    const help = compact
      ? 'AI can tidy the wording of your answers. It uses only what you wrote, flags anything it adds, and you can restore your own wording.'
      : 'AI can turn your answers into clear, professional resume wording. It uses only what you told us, flags anything it adds so you can check it, and you can restore your own wording at any time.';
    return `<div class="wiz-polish${compact ? ' wiz-polish-compact' : ''}">
      <div class="wiz-title" style="font-size:13px;">${compact ? 'Improve the wording with AI' : 'Want help with the wording?'} <span class="wiz-optional">(optional)</span></div>
      <div class="wiz-help">${help}</div>
      ${body}${msg}${result}</div>`;
  },

  scrollToPreview() { document.getElementById('preview-area').scrollIntoView({ behavior: 'smooth' }); },

  // ── rendering ──────────────────────────────────────────────────────────────
  render() {
    const w = state.wizard; if (!w) return;
    const step = WIZ_STEPS[w.step];
    const last = w.step === WIZ_STEPS.length - 1;
    const panel = document.getElementById('panel-guide');
    panel.classList.toggle('wiz-busy', Wiz.busy());                          // navigation is disabled while a polish runs
    panel.innerHTML = `
      <div class="wiz-progress">Step ${w.step + 1} of ${WIZ_STEPS.length}</div>
      <div class="wiz-dots">${WIZ_STEPS.map((s, i) => `<button class="wiz-dot${i === w.step ? ' active' : ''}" onclick="Wiz.go(${i})">${s.label}</button>`).join('')}</div>
      ${Wiz.steps[step.id](w)}
      <a class="wiz-preview-link" href="#preview-area" onclick="Wiz.scrollToPreview();return false;">See your live preview ↓</a>
      <div class="wiz-nav">
        ${w.step > 0 ? '<button class="wiz-back" onclick="Wiz.back()">Back</button>' : ''}
        <button class="wiz-next" onclick="Wiz.next()">${last ? 'Open in Editor' : 'Next'}</button>
        ${!last ? '<button class="wiz-skip" onclick="Wiz.next()">Skip</button>' : ''}
      </div>`;
    syncChrome();
    scheduleSave();
  },

  steps: {
    goal(w) {
      const d = state.data;
      const profile = w.profile || (w.path === 'first' ? 'first' : 'experienced');
      const opt = (v, label) => `<label class="wiz-check"><input type="radio" name="wiz-profile" ${profile === v ? 'checked' : ''} onchange="Wiz.setProfile('${v}')"> ${label}</label>`;
      const notes = {
        first: 'First resume? That&rsquo;s okay. Everyone starts somewhere. School, projects, volunteering and skills all count.',
        experienced: 'You&rsquo;ve worked before, so we&rsquo;ll walk through your jobs one at a time, in plain English.',
        changer: 'Changing direction? Your real experience still counts. List your jobs as they were; the wording can then bring out what carries over to the new work.'
      };
      return `
        <div class="wiz-title">What kind of work are you looking for?</div>
        <div class="wiz-help">A rough idea is fine. You can change it any time.</div>
        <label class="wiz-label">Work you&rsquo;re looking for <span class="wiz-optional">(optional)</span>
          <input class="wiz-input" value="${esc(w.target)}" oninput="Wiz.setTarget(this.value, event)" onchange="Wiz.applyTarget()" placeholder="e.g. customer service, warehouse, office assistant"></label>
        <div class="wiz-label">Which sounds most like you? <span class="wiz-optional">(helps match the wording to you)</span></div>
        <div class="wiz-checks">
          ${opt('first', 'This is my first resume')}
          ${opt('experienced', 'I&rsquo;ve worked before')}
          ${opt('changer', 'I&rsquo;m changing to a different kind of work')}
        </div>
        <label class="wiz-label">One-line introduction <span class="wiz-optional">(optional)</span>
          <input class="wiz-input" id="wiz-tagline" value="${esc(d.summary.tagline)}" oninput="Wiz.set('summary.tagline', this.value)" placeholder="e.g. Friendly student looking for a part-time retail job"></label>
        <div class="wiz-example">This is a short sentence at the top of your resume that tells an employer who you are and what you want. Not sure? Leave it blank, or keep the one we fill in from your answer above. Only say things that are true.</div>
        <div class="wiz-note">${notes[profile]}</div>`;
    },

    contact() {
      const c = state.data.contact;
      const f = (label, path, val, ph, opt) => `<label class="wiz-label">${label}${opt ? ' <span class="wiz-optional">(optional)</span>' : ''}<input class="wiz-input" value="${esc(val)}" oninput="Wiz.set('${path}', this.value)" placeholder="${esc(ph || '')}"></label>`;
      return `
        <div class="wiz-title">How can employers reach you?</div>
        <div class="wiz-help">This goes at the top of your resume.</div>
        ${f('Full name', 'name', state.data.name, 'e.g. Taylor Rivera')}
        ${f('Phone', 'contact.phone', c.phone, 'e.g. (555) 123-4567')}
        ${f('Email', 'contact.email', c.email, 'e.g. name@example.com')}
        ${f('City and state', 'contact.location', c.location, 'e.g. Dayton, OH')}
        ${f('LinkedIn', 'contact.linkedin', c.linkedin, '', true)}
        ${f('Website or portfolio', 'contact.website', c.website, '', true)}`;
    },

    work(w) {
      const jobs = state.data.experience;
      const choice = w.path === 'first' && w.work === null
        ? `<div class="wiz-title">Have you worked before?</div>
           <div class="wiz-help">Paid jobs, family businesses, babysitting, lawn care, or helping a neighbor all count.</div>
           <div class="wiz-choices">
             <button class="wiz-choice" onclick="Wiz.chooseWork('yes')">Yes, I&rsquo;ve had a paid job</button>
             <button class="wiz-choice" onclick="Wiz.chooseWork('informal')">Yes, but unpaid, family, or odd jobs</button>
             <button class="wiz-choice" onclick="Wiz.chooseWork('no')">Not yet. That&rsquo;s okay!</button>
           </div>`
        : '';
      if (choice) return choice;
      if (w.work === 'no') {
        return `<div class="wiz-title">No work history yet? No problem.</div>
          <div class="wiz-note">Your resume will lead with your education, then projects, volunteering and skills. Those show employers what you can do.</div>
          <button class="wiz-add" onclick="Wiz.chooseWork('yes')">Actually, I want to add a job</button>
          ${jobs.length ? '<div class="wiz-help" style="margin-top:10px;">You already have a job entered. It will stay on your resume unless you remove it in Edit Fields.</div>' : ''}`;
      }
      if (!jobs.length) jobs.push({ title: '', company: '', location: '', start: '', end: '', summary: '', bullets: [] });
      const title = w.path === 'first' ? 'Tell us about a job' : 'Tell us about your jobs';
      const help = w.path === 'first'
        ? 'Start with the most recent. Describe what you actually did.'
        : 'Start with your most recent job. Worked at one place for many years? Add it once, then use &ldquo;Add another role here&rdquo; if your duties changed.';
      return `
        <div class="wiz-title">${title}</div>
        <div class="wiz-help">${help}</div>
        ${jobs.map((e, i) => Wiz.jobCard(e, i)).join('')}
        <button class="wiz-add" onclick="Wiz.add('experience', {title:'',company:'',location:'',start:'',end:'',summary:'',bullets:[]})">+ Add another job</button>
        <button class="wiz-link" style="margin-top:8px;" onclick="Wiz.chooseWork('no')">I haven&rsquo;t worked before</button>`;
    },

    education() {
      const edu = state.data.education;
      return `
        <div class="wiz-title">What school or training have you done?</div>
        <div class="wiz-help">High school, GED, college, trade school or a certificate. Tell us what you finished, or what you&rsquo;re still working on. Skip this if you&rsquo;d rather not list any.</div>
        ${edu.map((e, i) => Wiz.eduCard(e, i)).join('')}
        <button class="wiz-add" onclick="Wiz.add('education', {degree:'',school:'',location:'',date:'',honors:''})">+ Add ${edu.length ? 'another school' : 'a school'}</button>`;
    },

    extras() {
      const d = state.data;
      const lineBox = (arr, i, rows, ph) => `<textarea class="wiz-input" id="wiz-lines-${arr}-${i}" rows="${rows}" oninput="Wiz.lines('${arr}', ${i}, this.value)" placeholder="${esc(ph)}">${esc((d[arr][i].bullets || []).join('\n'))}</textarea>`;
      return `
        <div class="wiz-title">Projects, volunteering, and training</div>
        <div class="wiz-help">These count as real experience, especially for a first resume. Everything here is optional: skip any part that doesn&rsquo;t apply to you.</div>

        <div class="wiz-label">Projects</div>
        <div class="wiz-example" style="margin-top:0;">Something you made, organized or worked on, for school, a club, your community, or on your own. For example: a school food drive, a science fair project, a family budget spreadsheet.</div>
        ${d.projects.map((p, i) => `
          <div class="wiz-card">
            <div class="wiz-card-head">Project ${i + 1}<button class="wiz-link" onclick="Wiz.remove('projects', ${i})">Remove</button></div>
            <label class="wiz-label">Project name<input class="wiz-input" value="${esc(p.name)}" oninput="Wiz.item('projects', ${i}, 'name', this.value)" placeholder="e.g. School food drive"></label>
            <label class="wiz-label">What was it about? <span class="wiz-optional">(optional, one short sentence)</span><input class="wiz-input" value="${esc(p.description)}" oninput="Wiz.item('projects', ${i}, 'description', this.value)" placeholder="e.g. Collected canned food for a local pantry"></label>
            <label class="wiz-label">What did you do? <span class="wiz-optional">(one thing per line)</span>${lineBox('projects', i, 3, 'Asked classmates to donate\nSorted and counted the cans')}</label>
          </div>`).join('')}
        <button class="wiz-add" onclick="Wiz.add('projects', {name:'',description:'',bullets:[]})">+ Add a project</button>

        <div class="wiz-label" style="margin-top:16px;">Volunteering and activities</div>
        <div class="wiz-example" style="margin-top:0;">Unpaid roles and groups you take part in: volunteering, clubs, sports teams, church or community groups.</div>
        ${d.volunteer.map((v, i) => `
          <div class="wiz-card">
            <div class="wiz-card-head">Activity ${i + 1}<button class="wiz-link" onclick="Wiz.remove('volunteer', ${i})">Remove</button></div>
            <label class="wiz-label">Your role or position<input class="wiz-input" value="${esc(v.title)}" oninput="Wiz.item('volunteer', ${i}, 'title', this.value)" placeholder="e.g. Volunteer, Team captain"></label>
            <label class="wiz-label">Name of the group or place<input class="wiz-input" value="${esc(v.organization)}" oninput="Wiz.item('volunteer', ${i}, 'organization', this.value)" placeholder="e.g. Community Food Pantry"></label>
            <div class="grid-2">
              <label class="wiz-label">From<input class="wiz-input" value="${esc(v.start)}" oninput="Wiz.item('volunteer', ${i}, 'start', this.value)" placeholder="e.g. 2025"></label>
              <label class="wiz-label">To<input class="wiz-input" value="${esc(v.end)}" oninput="Wiz.item('volunteer', ${i}, 'end', this.value)" placeholder="e.g. Present"></label>
            </div>
            <label class="wiz-label">What did you do? <span class="wiz-optional">(one thing per line)</span>${lineBox('volunteer', i, 3, 'Packed grocery boxes on Saturdays\nGreeted families as they arrived')}</label>
          </div>`).join('')}
        <button class="wiz-add" onclick="Wiz.add('volunteer', {title:'',organization:'',location:'',start:'',end:'',bullets:[]})">+ Add volunteering or an activity</button>

        <div class="wiz-label" style="margin-top:16px;">Training and courses</div>
        <div class="wiz-example" style="margin-top:0;">Classes, courses or certificates you finished, such as a food handler course or a first-aid class. Only list ones you really completed.</div>
        ${d.certifications.map((c, i) => `
          <div class="wiz-card">
            <div class="wiz-card-head">Training ${i + 1}<button class="wiz-link" onclick="Wiz.remove('certifications', ${i})">Remove</button></div>
            <label class="wiz-label">Course or certificate name<input class="wiz-input" value="${esc(c.name)}" oninput="Wiz.item('certifications', ${i}, 'name', this.value)" placeholder="e.g. Food Handler Course"></label>
            <label class="wiz-label">Who gave it <span class="wiz-optional">(optional)</span><input class="wiz-input" value="${esc(c.org)}" oninput="Wiz.item('certifications', ${i}, 'org', this.value)"></label>
            <label class="wiz-label">Year <span class="wiz-optional">(optional)</span><input class="wiz-input" value="${esc(c.date)}" oninput="Wiz.item('certifications', ${i}, 'date', this.value)" placeholder="e.g. 2026"></label>
          </div>`).join('')}
        <button class="wiz-add" onclick="Wiz.add('certifications', {name:'',org:'',date:''})">+ Add training or a course</button>
`;
    },

    skills() {
      const s = state.data.summary.skills;
      const custom = s.filter(x => !WIZ_SKILLS.includes(x)).join(', ');
      return `
        <div class="wiz-title">What are you good at?</div>
        <div class="wiz-help">Skills can come from anywhere: school, volunteering, hobbies, family responsibilities or a job. If you can do it, it counts. Tick the ones that are true for you.</div>
        <div class="wiz-checks">${WIZ_SKILLS.map((k, i) => `
          <label class="wiz-check"><input type="checkbox" ${s.includes(k) ? 'checked' : ''} onchange="Wiz.toggleSkill(WIZ_SKILLS[${i}], this.checked)"> ${esc(k)}</label>`).join('')}</div>
        <label class="wiz-label">Anything else? <span class="wiz-optional">(separate with commas)</span>
          <input class="wiz-input" value="${esc(custom)}" oninput="Wiz.setCustomSkills(this.value)" placeholder="e.g. Spanish, Microsoft Word, lawn equipment"></label>
        <div class="wiz-example">Only tick things you could show or explain to an employer.</div>`;
    },

    review() {
      const d = ResumeCore.clean(state.data);
      const row = (label, text, step) => `<div class="wiz-review-row"><div><strong>${label}</strong><br><span>${esc(text)}</span></div><button class="wiz-link" onclick="Wiz.go(${step})">Edit</button></div>`;
      const count = (n, one, none) => n ? `${n} ${one}${n === 1 ? '' : 's'}` : none;
      const missing = [];
      if (!d.name) missing.push('your name');
      if (!d.contact.email && !d.contact.phone) missing.push('a phone number or email');
      return `
        <div class="wiz-title">Looking good. Review your answers.</div>
        <div class="wiz-help">Nothing is final. You can change anything here or in Edit Fields.</div>
        ${missing.length ? `<div class="notice-box">Employers need a way to reach you. Add ${missing.join(' and ')}.</div>` : ''}
        ${row('You', d.name ? `${d.name}${d.contact.location ? ', ' + d.contact.location : ''}` : 'Not filled in yet', 1)}
        ${row('Work you want', d.summary.tagline || 'Skipped', 0)}
        ${row('Work', count(d.experience.length, 'job', d.experience.length === 0 ? 'None yet. That\'s okay!' : ''), 2)}
        ${row('School', count(d.education.length, 'school', 'Skipped'), 3)}
        ${row('Projects & activities', [count(d.projects.length, 'project', ''), count(d.volunteer.length, 'activity', ''), count(d.certifications.length, 'training item', '')].filter(Boolean).join(', ') || 'Skipped', 4)}
        ${row('Skills', count(d.summary.skills.length, 'skill', 'Skipped'), 5)}
        ${d.experience.length === 0 ? '<div class="wiz-note">With no work history, your resume leads with education, then projects and activities, then skills.</div>' : ''}
        <div class="wiz-note">Pick a design from the tabs above the preview. Simple styles like The Partner or The Builder work well for most first resumes. Then download a PDF or Word file with the buttons at the bottom right.</div>
        ${Wiz.polishBlock('')}`;
    }
  },

  eduCard(e, i) {
    const m = Wiz.eduModel(i);
    const other = m.qual === 'Other';
    const needsSubject = m.qual && !WIZ_NO_SUBJECT.includes(m.qual);
    const done = m.status !== 'ongoing';
    return `
      <div class="wiz-card">
        <div class="wiz-card-head">School ${i + 1}<button class="wiz-link" onclick="Wiz.remove('education', ${i})">Remove</button></div>
        <label class="wiz-label">School or college<input class="wiz-input" value="${esc(e.school)}" oninput="Wiz.item('education', ${i}, 'school', this.value)" placeholder="e.g. Oakwood High School"></label>
        <label class="wiz-label">Qualification <span class="wiz-optional">(the certificate or degree you earned, or are working toward)</span>
          <select class="wiz-input" onchange="Wiz.eduSet(${i}, 'qual', this.value)">
            <option value="" ${m.qual === '' ? 'selected' : ''}>Choose one…</option>
            ${WIZ_QUALS.map(q => `<option value="${esc(q)}" ${m.qual === q ? 'selected' : ''}>${esc(q)}</option>`).join('')}
            <option value="Other" ${other ? 'selected' : ''}>Something else (type it)</option>
          </select></label>
        ${other ? `<label class="wiz-label">Name of the qualification<input class="wiz-input" value="${esc(m.other)}" oninput="Wiz.eduSet(${i}, 'other', this.value)" placeholder="e.g. Nursing assistant program"></label>` : ''}
        ${needsSubject || other ? `<label class="wiz-label">Subject or field of study <span class="wiz-optional">(optional)</span><input class="wiz-input" value="${esc(m.field)}" oninput="Wiz.eduSet(${i}, 'field', this.value)" placeholder="e.g. Business, Nursing, Welding"></label>` : ''}
        <div class="wiz-label">Where are you with it?</div>
        <div class="wiz-checks">
          <label class="wiz-check"><input type="radio" name="wiz-edu-status-${i}" ${done ? 'checked' : ''} onchange="Wiz.eduSet(${i}, 'status', 'done')"> I finished this</label>
          <label class="wiz-check"><input type="radio" name="wiz-edu-status-${i}" ${done ? '' : 'checked'} onchange="Wiz.eduSet(${i}, 'status', 'ongoing')"> I&rsquo;m still studying</label>
        </div>
        <label class="wiz-label">${done ? 'Year finished' : 'Year you expect to finish'} ${done ? '' : '<span class="wiz-optional">(optional)</span>'}<input class="wiz-input" value="${esc(m.year)}" oninput="Wiz.eduSet(${i}, 'year', this.value)" placeholder="e.g. 2026"></label>
        <label class="wiz-label">Anything to highlight <span class="wiz-optional">(optional)</span><input class="wiz-input" value="${esc(e.honors)}" oninput="Wiz.item('education', ${i}, 'honors', this.value)" placeholder="e.g. Honor roll, Student council"></label>
      </div>`;
  },

  jobCard(e, i) {
    const present = String(e.end || '').toLowerCase() === 'present';
    const y = ResumeCore.sinceYear(e.start);
    const checks = WIZ_DUTY_CHECKS.map((c, k) => `
      <label class="wiz-check"><input type="checkbox" ${(e.bullets || []).includes(c) ? 'checked' : ''} onchange="Wiz.tick('experience', ${i}, ${k}, this.checked)"> ${esc(c)}</label>`).join('');
    return `
      <div class="wiz-card">
        <div class="wiz-card-head">Job ${i + 1}<button class="wiz-link" onclick="Wiz.remove('experience', ${i})">Remove</button></div>
        <label class="wiz-label">Job title<input class="wiz-input" value="${esc(e.title)}" oninput="Wiz.item('experience', ${i}, 'title', this.value)" placeholder="e.g. Cashier, Warehouse associate, Babysitter"></label>
        <label class="wiz-label">Where did you work?<input class="wiz-input" value="${esc(e.company)}" oninput="Wiz.item('experience', ${i}, 'company', this.value)" placeholder="e.g. Maple Market, or Family business"></label>
        <label class="wiz-label">City and state <span class="wiz-optional">(optional)</span><input class="wiz-input" value="${esc(e.location)}" oninput="Wiz.item('experience', ${i}, 'location', this.value)"></label>
        <div class="grid-2">
          <label class="wiz-label">Started<input class="wiz-input" value="${esc(e.start)}" oninput="Wiz.item('experience', ${i}, 'start', this.value)" placeholder="e.g. June 2019"></label>
          <label class="wiz-label">Ended<input class="wiz-input" value="${esc(e.end)}" ${present ? 'disabled' : ''} oninput="Wiz.item('experience', ${i}, 'end', this.value)" placeholder="e.g. May 2023"></label>
        </div>
        <label class="wiz-check" style="margin-top:6px;"><input type="checkbox" ${present ? 'checked' : ''} onchange="Wiz.current(${i}, this.checked)"> I still work here</label>
        ${present && y && e.company ? `<button class="wiz-chip" onclick="Wiz.addSinceLine(${i})">Add &ldquo;Working at ${esc(e.company)} since ${y}&rdquo; to my summary</button>` : ''}
        <label class="wiz-label">What did you do on a typical day? <span class="wiz-optional">(one thing per line)</span>
          <textarea class="wiz-input" id="wiz-lines-experience-${i}" rows="4" oninput="Wiz.lines('experience', ${i}, this.value)" placeholder="Stocked shelves and helped customers find items&#10;Kept the work area clean and safe">${esc((e.bullets || []).join('\n'))}</textarea></label>
        <div class="wiz-example">Short and simple is perfect. Did you train someone, fix a problem, or take on something new? Add it as another line.</div>
        <div class="wiz-label">Not sure what to write? Tick what&rsquo;s true:</div>
        <div class="wiz-checks">${checks}</div>
        <button class="wiz-link" onclick="Wiz.addRoleSameEmployer(${i})">+ Add another role at ${esc(e.company || 'this employer')} (promotion or new duties)</button>
      </div>`;
  }
};

function startGuided(path) { Wiz.start(path); }

// AI polish, offered at the top of the regular editor (Edit Fields) for any licensed resume with something to polish.
let lastEditPolish = null;
function renderEditPolish() {
  const el = document.getElementById('edit-polish');
  if (!el) return;
  const show = !!state.data && state.license.verified && ResumeCore.hasContent(state.data);
  const html = show ? Wiz.polishBlock('edit-', true) : '';
  if (html !== lastEditPolish) { el.innerHTML = html; lastEditPolish = html; }
}
