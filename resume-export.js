// PDF and Word export. Both draw REAL text (selectable, searchable, extractable) from the shared model in
// resume-core.js, so section order, empty-section hiding and content match the on-screen preview.
// Browser-only: needs window.jspdf (jspdf.umd.min.js) for PDF and window.docx (docx.umd.js) for Word.
(function (root) {
  const Core = root.ResumeCore;

  const hex = (h) => String(h || '#000000').replace('#', '');
  const rgb = (h) => { const x = hex(h); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) || 0); };
  const isSans = (t) => /helvetica|arial|sans/i.test(t.font || '');
  const SHADED = ['centered', 'modern-center', 'studio', 'foreman'];
  const CENTERED_HEADER = SHADED;                          // same four styles center their header
  const colors = (t, useAlt) => {
    const accent = useAlt && t.accentAlt ? t.accentAlt : t.accent;
    return { accent, accentLight: useAlt && t.accentAltLight ? t.accentAltLight : t.accentLight, accent2: t.accent2 || accent };
  };

  // ── PDF ───────────────────────────────────────────────────────────────────
  const PW = 612, PH = 792, M = 54, CW = PW - 2 * M, BOTTOM = PH - M;

  function buildPDF(data, t, useAlt) {
    const { jsPDF } = root.jspdf;
    const d = Core.clean(data);
    const style = t.style;
    const { accent, accentLight, accent2 } = colors(t, useAlt);
    const fam = isSans(t) ? 'helvetica' : 'times';
    const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
    let simplified = false;
    const safe = (s) => { const r = Core.pdfSafe(s); if (r.simplified) simplified = true; return r.text; };
    let y = M;

    const font = (fstyle, size, color) => { doc.setFont(fam, fstyle); doc.setFontSize(size); doc.setTextColor(...rgb(color)); };
    const width = (s) => doc.getTextWidth(s);
    const wrap = (s, w) => doc.splitTextToSize(s, w);
    const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = M; } };
    // Text is positioned by line box (top, line height) so spacing follows the preview's CSS.
    const put = (s, x, top, size, lh, opts) => doc.text(s, x, top + (lh - size) / 2 + size * 0.8, opts);
    // Letter-spaced text (the preview tracks the name and headings). Centering is computed here because the
    // PDF library does not include tracking when it aligns text.
    const TRACK_OK = root.RESUME_PDF_TRACKING !== false;
    function spaced(s, x, top, size, lh, em, align) {
      const cs = TRACK_OK ? em * size : 0;
      const total = width(s) + cs * Math.max(s.length - 1, 0);
      const x0 = align === 'center' ? x - total / 2 : x;
      doc.text(s, x0, top + (lh - size) / 2 + size * 0.8, cs ? { charSpace: cs } : undefined);
    }
    const rule = (x1, yy, x2, weight, color) => { doc.setDrawColor(...rgb(color)); doc.setLineWidth(weight); doc.line(x1, yy, x2, yy); };

    // A left item with an optional right-aligned date on the same line. Returns the height used.
    function row(left, right, o) {
      const lh = o.lh || o.size * 1.5;
      font(o.style || 'normal', o.size, o.color || '#111111');
      const rw = right ? (doc.setFontSize(o.rsize || 8), doc.setFont(fam, 'normal'), width(right) + 10) : 0;
      font(o.style || 'normal', o.size, o.color || '#111111');
      const lines = wrap(left, CW - rw);
      lines.forEach((ln, i) => put(ln, M, y + i * lh, o.size, lh));
      if (right) { font('normal', o.rsize || 8, '#555555'); put(right, M + CW, y, o.rsize || 8, lh, { align: 'right' }); }
      return lines.length * lh;
    }
    function text(s, x, w, o) {
      font(o.style || 'normal', o.size, o.color || '#222222');
      const lh = o.lh || o.size * 1.5;
      const lines = wrap(s, w);
      lines.forEach((ln, i) => put(ln, x, y + i * lh, o.size, lh));
      return lines.length * lh;
    }
    // The bullet is part of the first line's text ("• text") so text extraction reads it as one line.
    function bulletList(items) {
      font('normal', 8.5, '#222222');
      const indent = width('•  ');
      items.forEach((b) => {
        font('normal', 8.5, '#222222');
        const lines = wrap(b, CW - indent);
        const lh = 8.5 * 1.55;
        ensure(lines.length * lh + 2);
        lines.forEach((ln, i) => put(i === 0 ? '•  ' + ln : ln, i === 0 ? M : M + indent, y + i * lh, 8.5, lh));
        y += lines.length * lh + 2;
      });
    }

    // ── header ──
    function header() {
      const centered = CENTERED_HEADER.includes(style);
      const upper = centered || style === 'modern-left' || style === 'operator';
      let size = style === 'modern-left' || style === 'operator' ? 22 : centered ? 26 : 24;
      const nameText = safe(upper ? d.name.toUpperCase() : d.name);
      const contact = safe(Core.contactLine(d.contact));
      const nameEm = centered ? 0.22 : style === 'left-rule' ? 0.04 : style === 'editorial' ? 0.05 : 0.02;
      font('bold', size, '#111111');
      while (nameText && width(nameText) + (TRACK_OK ? nameEm * size : 0) * nameText.length > CW - (centered ? 70 : 0) && size > 14) { size -= 1; doc.setFontSize(size); }
      const nameLh = size * 1.25;

      if (centered) {
        doc.setFillColor(...rgb(accent));
        doc.triangle(PW - M, y, PW - M, y + 30, PW - M - 30, y, 'F');
        if (nameText) { font('bold', size, '#111111'); spaced(nameText, PW / 2, y, size, nameLh, nameEm, 'center'); y += nameLh; }
        if (contact) { y += 4; font('normal', 8, '#555555'); wrap(contact, CW - 70).forEach((ln) => { put(ln, PW / 2, y, 8, 12, { align: 'center' }); y += 12; }); }
        y += 10;
      } else if (style === 'left-rule') {
        if (nameText) { font('bold', size, '#111111'); spaced(nameText, M, y, size, nameLh, nameEm); y += nameLh; }
        y += 4; rule(M, y, M + CW, 1.1, accent); y += 5;
        if (contact) { font('normal', 8, '#555555'); wrap(contact, CW).forEach((ln) => { put(ln, M, y, 8, 12); y += 12; }); }
        y += 10;
      } else if (style === 'editorial') {
        const top = y;
        let leftH = 0;
        if (nameText) { font('bold', size, '#111111'); spaced(nameText, M, y, size, nameLh, nameEm); leftH = nameLh; }
        let rightH = 0;
        if (contact) { font('normal', 8, '#555555'); wrap(contact, CW * 0.45).forEach((ln, i) => { put(ln, M + CW, top + i * 12.8, 8, 12.8, { align: 'right' }); rightH += 12.8; }); }
        y = top + Math.max(leftH, rightH) + 6;
        rule(M, y, M + CW, 1.5, accent); y += 8;
      } else {                                              // modern-left, operator
        if (nameText) { font('bold', size, '#111111'); spaced(nameText, M, y, size, nameLh, nameEm); y += nameLh; }
        if (contact) { y += 3; font('normal', 8, '#555555'); wrap(contact, CW).forEach((ln) => { put(ln, M, y, 8, 12); y += 12; }); }
        y += 6; rule(M, y, M + CW, 2.2, accent2); y += 8;
      }
    }

    // ── sections ──
    function sectionHeader(title) {
      const lh = 12.75, pad = 3, h = lh + pad * 2;
      ensure(12 + h + 4 + 40);                              // never strand a heading at the bottom of a page
      y += 12;
      const label = safe(title.toUpperCase());
      if (SHADED.includes(style)) {
        doc.setFillColor(...rgb(accentLight));
        doc.rect(M, y, CW, h, 'F');
        font('bold', 8.5, accent);
        spaced(label, PW / 2, y + pad, 8.5, lh, 0.14, 'center');
      } else {
        font(style === 'editorial' ? 'bolditalic' : 'bold', 8.5, accent);
        spaced(label, M + 6, y + pad, 8.5, lh, 0.14);
        rule(M, y + h, M + CW, style === 'operator' ? 1.5 : 0.75, style === 'operator' ? accent2 : accent);
      }
      y += h + 4;
    }

    const render = {
      summary() {
        if (d.summary.tagline) { const h = text(safe(d.summary.tagline), M, CW, { size: 8.5, style: 'italic', color: '#222222' }); ensure(h); y += h + 3; }
        bulletList(d.summary.bullets.map(safe));
        if (d.summary.skills.length) { const s = safe(d.summary.skills.join(' – ')); y += 4; const h = text(s, M, CW, { size: 8, color: '#333333', lh: 12 }); y += h; }
      },
      skills() { const h = text(safe(d.summary.skills.join(' – ')), M, CW, { size: 8.5, color: '#222222' }); y += h; },
      experience() {
        d.experience.forEach((e) => {
          ensure(13.5 + 12.75 + 14);
          y += row(safe(e.title), safe(Core.dateRange(e.start, e.end)), { size: 9, style: 'bold' });
          const where = safe(`${e.company}${e.location ? ' | ' + e.location : ''}`);
          if (where) y += text(where, M, CW, { size: 8.5, style: 'italic', color: '#555555' }) + 2;
          if (e.summary) y += text(safe(e.summary), M, CW, { size: 8, style: 'italic', color: '#444444', lh: 12 }) + 2;
          bulletList(e.bullets.map(safe));
          y += 9;
        });
      },
      projects() {
        d.projects.forEach((p) => {
          ensure(13.5 + 12.75 + 14);
          y += row(safe(p.name), '', { size: 9, style: 'bold' });
          if (p.description) y += text(safe(p.description), M, CW, { size: 8.5, style: 'italic', color: '#555555' }) + 2;
          bulletList(p.bullets.map(safe));
          y += 7;
        });
      },
      volunteer() {
        d.volunteer.forEach((v) => {
          ensure(13.5 + 12.75 + 14);
          y += row(safe(v.title), safe(Core.dateRange(v.start, v.end)), { size: 9, style: 'bold' });
          const where = safe(`${v.organization}${v.location ? ' | ' + v.location : ''}`);
          if (where) y += text(where, M, CW, { size: 8.5, style: 'italic', color: '#555555' }) + 2;
          bulletList(v.bullets.map(safe));
          y += 7;
        });
      },
      education() {
        d.education.forEach((e) => {
          ensure(13.5 + 12.75);
          y += row(safe(e.degree), safe(e.date), { size: 9, style: 'bold' });
          const where = safe(`${e.school}${e.location ? ' | ' + e.location : ''}`);
          if (where) y += text(where, M, CW, { size: 8.5, style: 'italic', color: '#555555' });
          if (e.honors) y += text(safe(e.honors), M, CW, { size: 8, style: 'italic', color: '#444444', lh: 12 });
          y += 7;
        });
      },
      certifications() {
        d.certifications.forEach((c) => {
          ensure(14);
          y += row(safe(`${c.name}${c.org ? ' | ' + c.org : ''}`), safe(c.date), { size: 8.5, style: 'bold', rsize: 8.5 }) + 3;
        });
      },
      awards() { bulletList(d.awards.map(safe)); }
    };

    header();
    Core.sections(d, t).forEach((s) => { sectionHeader(s.title); render[s.key](); });

    doc.setProperties({ title: `${Core.pdfSafe(d.name).text || 'Resume'} - Resume` });
    return { doc, simplified, filename: `${Core.fileBase(d.name)}.pdf` };
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportPDF(data, t, useAlt) {
    const r = buildPDF(data, t, useAlt);
    download(r.doc.output('blob'), r.filename);
    return { simplified: r.simplified, filename: r.filename };
  }

  // ── Word ──────────────────────────────────────────────────────────────────
  async function buildWord(data, t, useAlt) {
    const { Document, Packer, Paragraph, TextRun, AlignmentType, ShadingType, BorderStyle, TabStopType, Tab } = root.docx;
    const d = Core.clean(data);
    const style = t.style;
    const { accent, accentLight, accent2 } = colors(t, useAlt);
    const font = /cambria/i.test(t.font || '') ? 'Cambria' : isSans(t) ? 'Arial' : 'Georgia';
    const WIDTH = 10080;                                    // 7 in text width in twips (8.5 in page, 0.75 in margins)
    const centered = CENTERED_HEADER.includes(style);
    const upper = centered || style === 'modern-left' || style === 'operator';
    const run = (text, o = {}) => new TextRun({ text, font, size: o.size || 17, bold: !!o.bold, italics: !!o.italics, color: hex(o.color || '#222222'), allCaps: !!o.caps });
    const p = [];
    const bar = (b) => ({ style: BorderStyle.SINGLE, size: b.size, color: hex(b.color), space: 1 });

    // header
    const nameSize = (style === 'modern-left' || style === 'operator' ? 22 : centered ? 26 : 24) * 2;
    const contact = Core.contactLine(d.contact);
    const align = centered ? AlignmentType.CENTER : AlignmentType.LEFT;
    if (d.name) p.push(new Paragraph({ alignment: align, spacing: { after: 40 }, children: [run(upper ? d.name.toUpperCase() : d.name, { bold: true, size: nameSize, color: '#111111' })] }));
    const headBorder = style === 'left-rule' ? bar({ size: 8, color: accent }) : style === 'editorial' ? bar({ size: 12, color: accent })
      : (style === 'modern-left' || style === 'operator') ? bar({ size: 18, color: accent2 }) : null;
    if (contact || headBorder) {
      p.push(new Paragraph({ alignment: align, spacing: { after: 160 }, border: headBorder ? { bottom: headBorder } : undefined, children: [run(contact, { size: 16, color: '#555555' })] }));
    }

    const heading = (title) => {
      const label = title.toUpperCase();
      if (SHADED.includes(style)) {
        return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 240, after: 80 }, keepNext: true, shading: { type: ShadingType.CLEAR, fill: hex(accentLight), color: 'auto' }, children: [run(label, { bold: true, size: 17, color: accent })] });
      }
      return new Paragraph({ spacing: { before: 240, after: 80 }, keepNext: true, border: { bottom: bar({ size: style === 'operator' ? 12 : 6, color: style === 'operator' ? accent2 : accent }) },
        children: [run(label, { bold: true, italics: style === 'editorial', size: 17, color: accent })] });
    };
    const titleRow = (left, right, o = {}) => new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: WIDTH }], spacing: { before: o.before == null ? 100 : o.before, after: 20 }, keepNext: true,
      children: [run(left, { bold: true, size: o.size || 18, color: '#111111' }), ...(right ? [new TextRun({ children: [new Tab(), right], font, size: 16, color: hex('#555555') })] : [])]
    });
    const sub = (text, o = {}) => new Paragraph({ spacing: { after: 40 }, keepNext: !!o.keepNext, children: [run(text, { italics: true, size: o.size || 17, color: o.color || '#555555' })] });
    const bullets = (arr) => arr.forEach((b) => p.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 30 }, children: [run(b)] })));

    const render = {
      summary() {
        if (d.summary.tagline) p.push(new Paragraph({ spacing: { after: 60 }, children: [run(d.summary.tagline, { italics: true })] }));
        bullets(d.summary.bullets);
        if (d.summary.skills.length) p.push(new Paragraph({ spacing: { before: 60, after: 80 }, children: [run(d.summary.skills.join(' – '), { size: 16, color: '#333333' })] }));
      },
      skills() { p.push(new Paragraph({ spacing: { after: 80 }, children: [run(d.summary.skills.join(' – '))] })); },
      experience() {
        d.experience.forEach((e) => {
          p.push(titleRow(e.title, Core.dateRange(e.start, e.end)));
          const where = `${e.company}${e.location ? ' | ' + e.location : ''}`;
          if (where) p.push(sub(where, { keepNext: !!(e.summary || e.bullets.length) }));
          if (e.summary) p.push(new Paragraph({ spacing: { after: 40 }, children: [run(e.summary, { italics: true, size: 16, color: '#444444' })] }));
          bullets(e.bullets);
        });
      },
      projects() {
        d.projects.forEach((pr) => {
          p.push(titleRow(pr.name, ''));
          if (pr.description) p.push(sub(pr.description));
          bullets(pr.bullets);
        });
      },
      volunteer() {
        d.volunteer.forEach((v) => {
          p.push(titleRow(v.title, Core.dateRange(v.start, v.end)));
          const where = `${v.organization}${v.location ? ' | ' + v.location : ''}`;
          if (where) p.push(sub(where));
          bullets(v.bullets);
        });
      },
      education() {
        d.education.forEach((e) => {
          p.push(titleRow(e.degree, e.date));
          const where = `${e.school}${e.location ? ' | ' + e.location : ''}`;
          if (where) p.push(sub(where));
          if (e.honors) p.push(new Paragraph({ spacing: { after: 40 }, children: [run(e.honors, { italics: true, size: 16, color: '#444444' })] }));
        });
      },
      certifications() {
        d.certifications.forEach((c) => p.push(new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: WIDTH }], spacing: { after: 50 },
          children: [run(c.name, { bold: true }), run(c.org ? ' | ' + c.org : ''), ...(c.date ? [new TextRun({ children: [new Tab(), c.date], font, size: 16, color: hex('#555555') })] : [])]
        })));
      },
      awards() { bullets(d.awards); }
    };
    Core.sections(d, t).forEach((s) => { p.push(heading(s.title)); render[s.key](); });
    if (!p.length) p.push(new Paragraph({ children: [run('')] }));

    const doc = new Document({
      creator: 'Flex & Grace Resume Generator', title: `${d.name || 'Resume'} - Resume`,
      sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } }, children: p }]
    });
    return { blob: await Packer.toBlob(doc), filename: `${Core.fileBase(d.name)}.docx` };
  }

  async function exportWord(data, t, useAlt) {
    const r = await buildWord(data, t, useAlt);
    download(r.blob, r.filename);
    return { filename: r.filename };
  }

  root.ResumeExport = { buildPDF, exportPDF, buildWord, exportWord };
})(typeof self !== 'undefined' ? self : this);
