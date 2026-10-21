// Shared resume model: normalises user/AI data and decides which sections appear, and in what order.
// The HTML preview, the PDF export and the Word export all consume this, so they cannot drift apart.
// Pure functions, no DOM: loadable in the browser (window.ResumeCore) and in Node (unit tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ResumeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
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

  return { blank, clean, hasContent, dateRange, contactLine, sections, pdfSafe, fileBase, sinceYear };
});
