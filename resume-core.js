// Shared resume model: normalises user/AI data and decides which sections appear, and in what order.
// The HTML preview, the PDF export and the Word export all consume this, so they cannot drift apart.
// Pure functions, no DOM: loadable in the browser (window.ResumeCore) and in Node (unit tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ResumeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Only text and plain numbers are content. An object, array or function (for example an AI reply that wraps a
  // bullet as {"text": "..."}) is dropped instead of being printed as "[object Object]" in the preview, PDF and Word.
  const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '').trim();
  const list = (a) => (Array.isArray(a) ? a : []).map(str).filter(Boolean);
  const objs = (a) => (Array.isArray(a) ? a : []).filter((o) => o && typeof o === 'object');
  const anyText = (o, keys) => keys.some((k) => (Array.isArray(o[k]) ? o[k].length : str(o[k])));

  // A blank resume with NO placeholder entries, so empty sections simply do not show.
  function blank() {
    return {
      name: '', contact: { phone: '', email: '', location: '', linkedin: '', website: '' },
      summary: { tagline: '', bullets: [], skills: [] },
      experience: [], education: [], certifications: [], projects: [], volunteer: [], awards: []
    };
  }

  // Trimmed copy with every empty bullet/entry removed. Never mutates the input.
  function clean(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const c = d.contact && typeof d.contact === 'object' ? d.contact : {};
    const s = d.summary && typeof d.summary === 'object' ? d.summary : {};
    const entry = (o, scalar, arrays) => {
      const out = {};
      scalar.forEach((k) => { out[k] = str(o[k]); });
      arrays.forEach((k) => { out[k] = list(o[k]); });
      return out;
    };
    const keep = (arr, scalar, arrays) => objs(arr)
      .map((o) => entry(o, scalar, arrays))
      .filter((o) => anyText(o, scalar.concat(arrays)));
    return {
      name: str(d.name),
      contact: { phone: str(c.phone), email: str(c.email), location: str(c.location), linkedin: str(c.linkedin), website: str(c.website) },
      summary: { tagline: str(s.tagline), bullets: list(s.bullets), skills: list(s.skills) },
      experience: keep(d.experience, ['title', 'company', 'location', 'start', 'end', 'summary'], ['bullets']),
      education: keep(d.education, ['degree', 'school', 'location', 'date', 'honors'], []),
      certifications: keep(d.certifications, ['name', 'org', 'date'], []),
      projects: keep(d.projects, ['name', 'description'], ['bullets']),
      volunteer: keep(d.volunteer, ['title', 'organization', 'location', 'start', 'end'], ['bullets']),
      awards: list(d.awards)
    };
  }

  function hasContent(raw) {
    const c = clean(raw);
    return !!(c.name || Object.values(c.contact).some(Boolean) || c.summary.tagline || c.summary.bullets.length || c.summary.skills.length ||
      c.experience.length || c.education.length || c.certifications.length || c.projects.length || c.volunteer.length || c.awards.length);
  }

  // Is there anything an AI could actually reword? (Needs more than just a name and contact details.)
  function hasWritableText(cleaned) {
    const c = cleaned;
    return !!(c.summary.tagline || c.summary.bullets.length || c.summary.skills.length ||
      c.experience.some((e) => e.bullets.length || e.summary) || c.projects.some((p) => p.bullets.length || p.description) || c.volunteer.some((v) => v.bullets.length));
  }

  function dateRange(start, end) {
    if (start && end) return `${start} – ${end}`;
    return start || end || '';
  }

  function contactLine(c) {
    return [c.phone, c.email, c.location, c.linkedin, c.website].filter(Boolean).join('  |  ');
  }

  // Ordered, non-empty sections for one template. `cleaned` must come from clean().
  // - Skills only get their own section when there is no summary text to carry them inline.
  // - With no work history, education leads and projects/volunteering come next (nothing implies corporate seniority).
  // - Academic templates lead with education; The Foreman leads with certifications (as its design intends).
  function sections(cleaned, template) {
    const d = cleaned;
    const id = template && template.id;
    const hasSummaryText = !!(d.summary.tagline || d.summary.bullets.length);
    const parts = {
      summary: hasSummaryText ? { key: 'summary', title: 'Professional Summary' } : null,
      skills: d.summary.skills.length && !hasSummaryText ? { key: 'skills', title: 'Skills' } : null,
      experience: d.experience.length ? { key: 'experience', title: 'Experience' } : null,
      projects: d.projects.length ? { key: 'projects', title: 'Projects' } : null,
      volunteer: d.volunteer.length ? { key: 'volunteer', title: 'Volunteer & Activities' } : null,
      education: d.education.length ? { key: 'education', title: 'Education' } : null,
      certifications: d.certifications.length ? { key: 'certifications', title: 'Certifications & Training' } : null,
      awards: d.awards.length ? { key: 'awards', title: 'Awards & Recognition' } : null
    };
    let order;
    if (id === 'foreman') order = ['summary', 'skills', 'certifications', 'experience', 'projects', 'volunteer', 'education', 'awards'];
    else if (id === 'scholar' || id === 'researcher') order = ['summary', 'skills', 'education', 'experience', 'projects', 'volunteer', 'certifications', 'awards'];
    else if (!d.experience.length) order = ['summary', 'skills', 'education', 'projects', 'volunteer', 'certifications', 'awards'];
    else order = ['summary', 'skills', 'experience', 'projects', 'volunteer', 'education', 'certifications', 'awards'];
    return order.map((k) => parts[k]).filter(Boolean);
  }

  // ── PDF-safe text ──────────────────────────────────────────────────────────
  // The built-in PDF fonts cover Windows-1252 only. Accented Latin letters are kept; anything else is
  // reduced to a plain letter where one exists, otherwise to "?", and the caller is told so it can warn.
  const WIN1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
  function pdfSafe(text) {
    let simplified = false;
    let out = '';
    for (const ch of String(text == null ? '' : text).normalize('NFC')) {
      const cp = ch.codePointAt(0);
      if (cp === 9 || cp === 10 || cp === 13 || (cp >= 32 && cp <= 126) || (cp >= 160 && cp <= 255) || WIN1252_EXTRA.includes(ch)) { out += ch; continue; }
      if (cp === 0x2022 || cp === 0x25CF) { out += '•'; continue; }
      simplified = true;
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += /^[\x20-\x7e]+$/.test(base) ? base : '?';
    }
    return { text: out, simplified };
  }

  function fileBase(name) {
    const base = str(name).replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
    return base ? `${base}_Resume` : 'Resume';
  }

  // Calendar-year span for "worked here since" helpers. Returns null when it cannot be read from the dates.
  function sinceYear(start) {
    const m = /\b(19|20)\d{2}\b/.exec(str(start));
    return m ? Number(m[0]) : null;
  }

  // Which generation of the factual-integrity layer this build contains. The page and the AI functions both read it from this one file,
  // so a stale deploy is visible without spending a credit: in the browser console `ResumeCore.GUARD_VERSION`, and the same value comes
  // back from the AI functions as `guard.version` (see SETUP.md 5b). Bump it whenever the rules for what an AI result may contain change.
  const GUARD_VERSION = 'entry-scope-withhold-3';

  // "Work you're looking for" -> the one-line intro. Customers type a job title ("Retail Sales Associate") but also whole phrases
  // ("Seeking a Retail Sales Associate position.", "looking for a job as a cashier"). Strip our own framing from what they typed so it is
  // never said twice, then frame it once. Returns '' when nothing usable is left (an empty box, or only framing words such as "Seeking a").
  function introFromTarget(value) {
    let r = str(value).replace(/\s+/g, ' ').trim();
    const lead = /^(?:(?:i\s*(?:am|['’]m)\s+)?(?:currently\s+)?(?:seeking|seek|looking\s+for|looking\s+to\s+find|searching\s+for|hoping\s+(?:to\s+find|for)|want(?:ing)?|need|applying\s+(?:for|to))\b[\s:,-]*)+/i;
    const tail = /\s+(?:position|positions|role|roles|job|jobs|opportunity|opportunities|work)\s*[.!]*$/i;
    for (let i = 0; i < 3; i++) {
      const before = r;
      r = r.replace(lead, '').replace(/^(?:a\s+job\s+as|a\s+position\s+as|a\s+role\s+as|work\s+as|employment\s+as|to\s+work\s+as|to\s+be)\b[\s:,-]*/i, '')
        .replace(/^(?:a|an|the)\b\s*/i, '').replace(/^[\s:,.\-–—]+/, '').replace(tail, '').replace(/[\s.,;:!\-–—]+$/, '').trim();
      if (r === before) break;
    }
    if (!/[\p{L}\p{N}]/u.test(r)) return '';
    if (/^(?:a|an|the|as|for|to|of|in|at|position|positions|role|roles|job|jobs|work|opportunity|opportunities)$/i.test(r)) return '';
    const first = r.split(' ')[0];
    const vowelSound = /^(?:[aeio]|hon|hou)/i.test(first) && !/^(?:one|once)/i.test(first)
      || /^u(?!ni|s[eu]|ti|k|r[aeou]|ber)/i.test(first)
      || /^[AEFHILMNORSX][A-Z]{1,5}$/.test(first);                       // spoken letter by letter: "an HR assistant", "an LPN"
    const article = vowelSound ? 'an' : 'a';
    return `Seeking ${article} ${r} position`;
  }

  return { blank, clean, hasContent, hasWritableText, dateRange, contactLine, sections, pdfSafe, fileBase, sinceYear, introFromTarget, GUARD_VERSION };
});
