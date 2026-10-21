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

const WIZ_EDU_CHIPS = ['High school diploma', 'GED', 'Some college', 'Currently in school'];

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
    state.flags = new Set(); state.preTailor = null;
    state.wizard = { path, step: 0, work: null, target: '', autoTagline: '' };
    if (state.selectedTemplate.id === 'boardroom') selectTemplate('partner');   // plainest default; customers can change it
    Wiz.render();
    switchPanel('guide');
    renderEditFields();
    renderPreview();
  },

  go(i) { state.wizard.step = Math.max(0, Math.min(WIZ_STEPS.length - 1, i)); Wiz.render(); document.getElementById('panel-guide').scrollTop = 0; },
  next() { if (state.wizard.step >= WIZ_STEPS.length - 1) return Wiz.finish(); Wiz.go(state.wizard.step + 1); },
  back() { Wiz.go(state.wizard.step - 1); },
  finish() { renderEditFields(); switchPanel('edit'); },

  // ── small data helpers (all write to state.data) ───────────────────────────
  set(path, v) { updateField(path, v); },
  item(arr, i, field, v) { updateArrayItem(arr, i, field, v); },
  lines(arr, i, v) { state.data[arr][i].bullets = v.split('\n').map(x => x.trim()).filter(Boolean); renderPreview(); },
  add(arr, tpl) { arrayAt(arr).push(tpl); Wiz.render(); renderPreview(); },
  remove(arr, i) { arrayAt(arr).splice(i, 1); Wiz.render(); renderPreview(); },
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
  setEdu(i, field, v) { updateArrayItem('education', i, field, v); Wiz.render(); },
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
  scrollToPreview() { document.getElementById('preview-area').scrollIntoView({ behavior: 'smooth' }); },

  // ── rendering ──────────────────────────────────────────────────────────────
  render() {
    const w = state.wizard; if (!w) return;
    const step = WIZ_STEPS[w.step];
    const last = w.step === WIZ_STEPS.length - 1;
    document.getElementById('panel-guide').innerHTML = `
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
      return `
        <div class="wiz-title">What kind of job are you looking for?</div>
        <div class="wiz-help">A rough idea is fine. You can change it any time.</div>
        <label class="wiz-label">Job you want <span class="wiz-optional">(optional)</span>
          <input class="wiz-input" value="${esc(w.target)}" oninput="Wiz.setTarget(this.value)" placeholder="e.g. customer service, warehouse, office assistant"></label>
        <label class="wiz-label">Headline at the top of your resume <span class="wiz-optional">(optional)</span>
          <input class="wiz-input" id="wiz-tagline" value="${esc(d.summary.tagline)}" oninput="Wiz.set('summary.tagline', this.value)" placeholder="e.g. Dependable, friendly, and quick to learn"></label>
        <div class="wiz-example">Write it in your own words. Only say things that are true.</div>
        ${w.path === 'first'
          ? '<div class="wiz-note">First resume? That&rsquo;s okay. Everyone starts somewhere. School, projects, volunteering and skills all count.</div>'
          : '<div class="wiz-note">Starting fresh? We&rsquo;ll walk through your jobs one at a time, in plain English.</div>'}`;
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
        <div class="wiz-title">What school or training have you completed?</div>
        <div class="wiz-help">High school, GED, college, trade school, or classes. Skip this if you&rsquo;d rather not list any.</div>
        ${edu.map((e, i) => `
          <div class="wiz-card">
            <div class="wiz-card-head">School ${i + 1}<button class="wiz-link" onclick="Wiz.remove('education', ${i})">Remove</button></div>
            <label class="wiz-label">School<input class="wiz-input" value="${esc(e.school)}" oninput="Wiz.item('education', ${i}, 'school', this.value)" placeholder="e.g. Oakwood High School"></label>
            <label class="wiz-label">What you studied or finished<input class="wiz-input" value="${esc(e.degree)}" oninput="Wiz.item('education', ${i}, 'degree', this.value)" placeholder="e.g. High School Diploma"></label>
            <div class="wiz-chips">${WIZ_EDU_CHIPS.map(c => `<button class="wiz-chip" onclick="Wiz.setEdu(${i}, 'degree', '${c}')">${c}</button>`).join('')}</div>
            <label class="wiz-label">Year finished, or expected year<input class="wiz-input" value="${esc(e.date)}" oninput="Wiz.item('education', ${i}, 'date', this.value)" placeholder="e.g. 2026"></label>
            <label class="wiz-label">Anything to highlight <span class="wiz-optional">(optional)</span><input class="wiz-input" value="${esc(e.honors)}" oninput="Wiz.item('education', ${i}, 'honors', this.value)" placeholder="e.g. Honor roll, Student council"></label>
          </div>`).join('')}
        <button class="wiz-add" onclick="Wiz.add('education', {degree:'',school:'',location:'',date:'',honors:''})">+ Add ${edu.length ? 'another school' : 'a school'}</button>`;
    },

    extras() {
      const d = state.data;
      const lineBox = (arr, i, rows, ph) => `<textarea class="wiz-input" id="wiz-lines-${arr}-${i}" rows="${rows}" oninput="Wiz.lines('${arr}', ${i}, this.value)" placeholder="${esc(ph)}">${esc((d[arr][i].bullets || []).join('\n'))}</textarea>`;
      return `
        <div class="wiz-title">Projects, volunteering, and training</div>
        <div class="wiz-help">These count as real experience, especially for a first resume. Everything here is optional.</div>

        <div class="wiz-label">Projects <span class="wiz-optional">(school, personal, or community)</span></div>
        ${d.projects.map((p, i) => `
          <div class="wiz-card">
            <div class="wiz-card-head">Project ${i + 1}<button class="wiz-link" onclick="Wiz.remove('projects', ${i})">Remove</button></div>
            <label class="wiz-label">Name<input class="wiz-input" value="${esc(p.name)}" oninput="Wiz.item('projects', ${i}, 'name', this.value)" placeholder="e.g. School food drive"></label>
            <label class="wiz-label">What was it? <span class="wiz-optional">(optional)</span><input class="wiz-input" value="${esc(p.description)}" oninput="Wiz.item('projects', ${i}, 'description', this.value)" placeholder="e.g. Collected canned food for a local pantry"></label>
            <label class="wiz-label">What did you do? <span class="wiz-optional">(one thing per line)</span>${lineBox('projects', i, 3, 'Asked classmates to donate\nSorted and counted the cans')}</label>
          </div>`).join('')}
        <button class="wiz-add" onclick="Wiz.add('projects', {name:'',description:'',bullets:[]})">+ Add a project</button>

        <div class="wiz-label" style="margin-top:16px;">Volunteering and activities <span class="wiz-optional">(clubs, teams, church, community)</span></div>
        ${d.volunteer.map((v, i) => `
          <div class="wiz-card">
            <div class="wiz-card-head">Activity ${i + 1}<button class="wiz-link" onclick="Wiz.remove('volunteer', ${i})">Remove</button></div>
            <label class="wiz-label">Your role<input class="wiz-input" value="${esc(v.title)}" oninput="Wiz.item('volunteer', ${i}, 'title', this.value)" placeholder="e.g. Volunteer, Team captain"></label>
            <label class="wiz-label">Group or place<input class="wiz-input" value="${esc(v.organization)}" oninput="Wiz.item('volunteer', ${i}, 'organization', this.value)" placeholder="e.g. Community Food Pantry"></label>
            <div class="grid-2">
              <label class="wiz-label">From<input class="wiz-input" value="${esc(v.start)}" oninput="Wiz.item('volunteer', ${i}, 'start', this.value)" placeholder="e.g. 2025"></label>
              <label class="wiz-label">To<input class="wiz-input" value="${esc(v.end)}" oninput="Wiz.item('volunteer', ${i}, 'end', this.value)" placeholder="e.g. Present"></label>
            </div>
            <label class="wiz-label">What did you do? <span class="wiz-optional">(one thing per line)</span>${lineBox('volunteer', i, 3, 'Packed grocery boxes on Saturdays\nGreeted families as they arrived')}</label>
          </div>`).join('')}
        <button class="wiz-add" onclick="Wiz.add('volunteer', {title:'',organization:'',location:'',start:'',end:'',bullets:[]})">+ Add volunteering or an activity</button>

        <div class="wiz-label" style="margin-top:16px;">Training, courses, or certificates you&rsquo;ve completed</div>
        ${d.certifications.map((c, i) => `
          <div class="wiz-card">
            <div class="wiz-card-head">Training ${i + 1}<button class="wiz-link" onclick="Wiz.remove('certifications', ${i})">Remove</button></div>
            <label class="wiz-label">Name<input class="wiz-input" value="${esc(c.name)}" oninput="Wiz.item('certifications', ${i}, 'name', this.value)" placeholder="e.g. Food Handler Course"></label>
            <label class="wiz-label">Who gave it <span class="wiz-optional">(optional)</span><input class="wiz-input" value="${esc(c.org)}" oninput="Wiz.item('certifications', ${i}, 'org', this.value)"></label>
            <label class="wiz-label">Year <span class="wiz-optional">(optional)</span><input class="wiz-input" value="${esc(c.date)}" oninput="Wiz.item('certifications', ${i}, 'date', this.value)" placeholder="e.g. 2026"></label>
          </div>`).join('')}
        <button class="wiz-add" onclick="Wiz.add('certifications', {name:'',org:'',date:''})">+ Add training or a course</button>
        <div class="wiz-example">Only list certificates you actually earned.</div>`;
    },

    skills() {
      const s = state.data.summary.skills;
      const custom = s.filter(x => !WIZ_SKILLS.includes(x)).join(', ');
      return `
        <div class="wiz-title">What are you good at?</div>
        <div class="wiz-help">Tick the ones that are true for you.</div>
        <div class="wiz-checks">${WIZ_SKILLS.map((k, i) => `
          <label class="wiz-check"><input type="checkbox" ${s.includes(k) ? 'checked' : ''} onchange="Wiz.toggleSkill(WIZ_SKILLS[${i}], this.checked)"> ${esc(k)}</label>`).join('')}</div>
        <label class="wiz-label">Anything else? <span class="wiz-optional">(separate with commas)</span>
          <input class="wiz-input" value="${esc(custom)}" oninput="Wiz.setCustomSkills(this.value)" placeholder="e.g. Spanish, Microsoft Word, lawn equipment"></label>`;
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
        ${row('Job you want', d.summary.tagline || 'Skipped', 0)}
        ${row('Work', count(d.experience.length, 'job', d.experience.length === 0 ? 'None yet. That\'s okay!' : ''), 2)}
        ${row('School', count(d.education.length, 'school', 'Skipped'), 3)}
        ${row('Projects & activities', [count(d.projects.length, 'project', ''), count(d.volunteer.length, 'activity', ''), count(d.certifications.length, 'training item', '')].filter(Boolean).join(', ') || 'Skipped', 4)}
        ${row('Skills', count(d.summary.skills.length, 'skill', 'Skipped'), 5)}
        ${d.experience.length === 0 ? '<div class="wiz-note">With no work history, your resume leads with education, then projects and activities, then skills.</div>' : ''}
        <div class="wiz-note">Pick a design from the tabs above the preview. Simple styles like The Partner or The Builder work well for most first resumes. Then download a PDF or Word file with the buttons at the bottom right.</div>`;
    }
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
