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
    if (WIZARD_REQUIRES_LICENSE && !state.license.verified) {
      pendingGeneration = () => Wiz.start(path);
      showGate('Enter your access code to start building. Building your resume by hand never uses one of your generations.');
      return;
    }
    if (state.data && ResumeCore.hasContent(state.data) && !confirm('This will replace the resume currently in the editor. Start a new one?')) return;
    state.data = ResumeCore.blank();
    state.flags = new Set(); state.preTailor = null; state.polishOriginal = null;
    state.polish = null;
    state.wizard = { path, step: 0, work: null, target: '', autoTagline: '', profile: path === 'first' ? 'first' : 'experienced', edu: [] };
    if (state.selectedTemplate.id === 'boardroom') selectTemplate('partner');   // plainest default; customers can change it
    Wiz.render();
    switchPanel('guide');
    renderEditFields();
    renderPreview();
  },

  busy() { return !!(state.polish && state.polish.busy); },   // a paid polish is running: stay put
  go(i) { if (Wiz.busy()) return; state.wizard.step = Math.max(0, Math.min(WIZ_STEPS.length - 1, i)); Wiz.render(); document.getElementById('panel-guide').scrollTop = 0; },
  next() { if (Wiz.busy()) return; if (state.wizard.step >= WIZ_STEPS.length - 1) return Wiz.finish(); Wiz.go(state.wizard.step + 1); },
  back() { if (Wiz.busy()) return; Wiz.go(state.wizard.step - 1); },
  finish() { renderEditFields(); switchPanel('edit'); document.getElementById('panel-edit').scrollTop = 0; renderEditPolish(); },   // start at the top, where AI polish is offered

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
  setTarget(v) {
    const w = state.wizard; w.target = v;
    const t = state.data.summary.tagline;
    if (!t || t === w.autoTagline) {
      w.autoTagline = v.trim() ? `Seeking a ${v.trim()} position` : '';
      state.data.summary.tagline = w.autoTagline;
      const el = document.getElementById('wiz-tagline'); if (el) el.value = w.autoTagline;
      renderPreview();
    }
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
  polishState() { return state.polish || (state.polish = { confirm: false, busy: false, requestId: null, msg: '', kind: '', done: null }); },
  // Polish is offered both on the Review step and at the top of the regular editor; both views read the same state.
  refreshPolish() { if (state.wizard) Wiz.render(); renderEditPolish(); },
  askPolish() { const p = Wiz.polishState(); if (p.busy) return; p.confirm = true; p.msg = ''; Wiz.refreshPolish(); },
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
    p.busy = true; p.confirm = false; p.msg = ''; p.kind = '';
    if (!p.requestId) p.requestId = Wiz.newRequestId();                     // reused on a manual retry, so a lost reply is never charged twice
    Wiz.refreshPolish();
    try {
      const res = await fetch('/.netlify/functions/polish-resume', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: state.license.code, resume: state.data, target: w.target || '', profile: w.profile || undefined, requestId: p.requestId })
      });
      let json = null; try { json = await res.json(); } catch (e) { /* non-JSON gateway error */ }
      let parsed = null;
      if (res.ok && json && json.result) { try { parsed = JSON.parse(json.result); } catch (e) { parsed = null; } }
      if (parsed) {
        state.polishOriginal = ResumeCore.clean(state.data);               // the customer's own wording, for Restore
        state.data = parsed;
        state.tailorToken = json.tailorToken || null;
        if (typeof json.usesRemaining === 'number') state.license.usesRemaining = json.usesRemaining;
        if (typeof json.maxUses === 'number') state.license.maxUses = json.maxUses;
        const unverified = Array.isArray(json.unverified) ? json.unverified : [];
        state.flags = new Set(unverified.map(u => String(u.text || '').trim()).filter(Boolean));
        state.preTailor = null;
        p.requestId = null;
        p.done = { unverified };
        p.msg = ''; p.kind = '';
        renderLicenseBadge(); renderEditFields(); renderPreview();
      } else {
        await Wiz.polishFailed(res.status, json);
      }
    } catch (e) {
      // The request may or may not have finished. Keep the request id so a manual retry cannot be charged twice.
      p.msg = 'We couldn’t confirm whether that finished. Your resume is unchanged. Please check the generations counter above, then try again.';
      p.kind = 'err';
      refreshLicenseCounter();
    } finally {
      p.busy = false;
      Wiz.refreshPolish();
    }
  },

  async polishFailed(status, json) {
    const p = Wiz.polishState();
    const message = (json && json.error) || 'Something went wrong while polishing. You haven’t been charged. Please try again.';
    p.kind = 'err'; p.msg = message;
    if (status === 401 || (status === 403 && !(json && json.usesRemaining === 0))) {
      state.license = { code: null, verified: false, usesRemaining: null, maxUses: null };
      sessionStorage.removeItem(LICENSE_STORAGE_KEY);
      renderLicenseBadge(); showGate(message); p.requestId = null; return;
    }
    if (status === 403) {                                                   // all generations used
      state.license.usesRemaining = 0;
      if (typeof json.maxUses === 'number') state.license.maxUses = json.maxUses;
      renderLicenseBadge(); p.requestId = null; return;
    }
    if (status === 409) return;                                             // something is already running: keep the id
    p.requestId = null;                                                     // a definite, uncharged failure: next try is a fresh request
    await refreshLicenseCounter();
  },

  // Which parts of the resume did the AI reword? (compared with the customer's own wording)
  changedParts() {
    const o = state.polishOriginal; if (!o) return [];
    const d = ResumeCore.clean(state.data);
    const out = [];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (!same([o.summary.tagline, o.summary.bullets, o.summary.skills], [d.summary.tagline, d.summary.bullets, d.summary.skills])) out.push({ kind: 'summary', i: 0, label: 'Headline and summary' });
    [['experience', 'title', 'Job'], ['projects', 'name', 'Project'], ['volunteer', 'title', 'Activity']].forEach(([k, f, name]) => {
      d[k].forEach((e, i) => {
        const before = o[k][i]; if (!before) return;
        if (!same([before.bullets, before.summary || '', before.description || ''], [e.bullets, e.summary || '', e.description || ''])) out.push({ kind: k, i, label: `${name}: ${e[f] || before[f] || i + 1}` });
      });
    });
    return out;
  },
  restorePart(kind, i) {
    const o = state.polishOriginal; if (!o) return;
    if (kind === 'summary') state.data.summary = JSON.parse(JSON.stringify(o.summary));
    else if (o[kind] && o[kind][i] && state.data[kind] && state.data[kind][i]) {
      ['bullets', 'summary', 'description'].forEach(f => { if (f in o[kind][i]) state.data[kind][i][f] = JSON.parse(JSON.stringify(o[kind][i][f])); });
    }
    const lines = new Set();                                              // keep only flags whose line is still in the resume
    (function walk(v) { if (typeof v === 'string') lines.add(v.trim()); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(state.data);
    state.flags = new Set([...state.flags].filter(t => lines.has(t)));
    renderEditFields(); renderPreview(); Wiz.refreshPolish();
  },
  restoreAll() {
    if (!state.polishOriginal) return;
    state.data = JSON.parse(JSON.stringify(state.polishOriginal));
    state.polishOriginal = null; state.flags = new Set(); Wiz.polishState().done = null;
    renderEditFields(); renderPreview(); Wiz.refreshPolish();
  },

  polishBlock(prefix = '', compact = false) {
    const p = Wiz.polishState();
    const left = state.license.usesRemaining, max = state.license.maxUses;
    const writable = ResumeCore.hasWritableText(ResumeCore.clean(state.data));
    const plural = (n) => `${n} generation${n === 1 ? '' : 's'}`;
    let body;
    if (p.busy) {
      body = '<div class="loading-indicator"><div class="spinner"></div>Polishing your resume… this can take up to a minute. Please keep this page open.</div>';
    } else if (left === 0) {
      body = `<div class="wiz-err">You’ve used all ${max || 5} generations on this code.${etsyLinkHTML()} Your resume is still fully editable and downloadable.</div>`;
    } else if (!writable) {
      body = '<div class="wiz-example">Add a few answers first (what you did in a job, a project, or your skills), then come back.</div>';
    } else if (p.confirm) {
      body = `<div class="wiz-confirm"><strong>This will use 1 of your ${typeof left === 'number' ? plural(left) + ' remaining' : 'generations'}.</strong>
          You are only charged if the polish completes. If it fails, nothing is used.
          <div><button class="wiz-polish-btn" style="width:auto" onclick="Wiz.doPolish()" id="${prefix}polish-confirm">Yes, polish my resume (uses 1)</button><button class="wiz-back" onclick="Wiz.cancelPolish()">Cancel</button></div></div>`;
    } else {
      body = `<button class="wiz-polish-btn" onclick="Wiz.askPolish()" id="${prefix}polish-btn">✨ Polish My Resume with AI</button>
        <div class="wiz-example">Uses 1 of your ${typeof left === 'number' ? left : 'remaining'} generation${left === 1 ? '' : 's'}${typeof left === 'number' && max ? ` (of ${max})` : ''}. Typing, previewing, editing and downloading never use one.</div>`;
    }
    let result = '';
    if (p.done && state.polishOriginal) {
      const parts = Wiz.changedParts(); const unv = p.done.unverified || [];
      result = `<div class="wiz-ok"><strong>✓ Polished.</strong> That used 1 generation${typeof left === 'number' ? ` (${left} of ${max || 5} left)` : ''}. Read it over: it’s your resume, so edit anything.
        ${parts.length ? `<div style="margin-top:6px;"><strong>AI reworded:</strong>${parts.map(c => `<div class="wiz-review-row"><div>${esc(c.label)}</div><button class="wiz-link" onclick="Wiz.restorePart('${c.kind}', ${c.i})">Restore my wording</button></div>`).join('')}</div>` : ''}
        ${unv.length ? `<div class="notice-box"><strong>Please check ${unv.length} line${unv.length === 1 ? '' : 's'}.</strong> The AI added something that wasn’t in your answers (marked yellow in Edit Fields). Keep only what is true.
          <ul style="margin:6px 0 0 16px;">${unv.slice(0, 8).map(u => `<li>${esc(u.text)} <em>(${esc((u.reasons || []).join('; '))})</em></li>`).join('')}</ul></div>` : ''}
        <button class="wiz-link" onclick="Wiz.restoreAll()">Restore all my original wording</button></div>`;
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
          <input class="wiz-input" value="${esc(w.target)}" oninput="Wiz.setTarget(this.value)" placeholder="e.g. customer service, warehouse, office assistant"></label>
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
