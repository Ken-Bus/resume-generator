// Read text back out of exported files (no external tools needed).
const zlib = require('zlib');

// Text drawn by a PDF's own text operators. An image-only PDF has none.
function pdfText(buf) {
  let out = ''; let i = 0;
  while ((i = buf.indexOf('stream', i)) >= 0) {
    const start = buf[i + 6] === 13 ? i + 8 : i + 7; const end = buf.indexOf('endstream', start); if (end < 0) break;
    try { out += zlib.inflateSync(buf.subarray(start, end)).toString('latin1') + '\n'; } catch (e) { /* not flate */ }
    i = end + 9;
  }
  const CP = { 0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™' };
  out = out.replace(/[\x80-\x9f]/g, (c) => CP[c.charCodeAt(0)] || c);
  const strings = [];
  out.replace(/\(((?:\\.|[^\\)])*)\)\s*Tj/g, (_, s) => { strings.push(s.replace(/\\(.)/g, '$1')); return ''; });
  return strings.join('\n');
}
const pdfImages = (buf) => (buf.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length;
const pdfPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

// word/document.xml text from a .docx (minimal zip reader).
function docxText(b) {
  let eocd = b.length - 22; while (eocd > 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = b.readUInt32LE(eocd + 16); const n = b.readUInt16LE(eocd + 10);
  for (let k = 0; k < n; k++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nlen);
    if (name === 'word/document.xml') {
      const lnlen = b.readUInt16LE(off + 26), lxlen = b.readUInt16LE(off + 28); const data = b.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
      const xml = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
      return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error('document.xml not found');
}

module.exports = { pdfText, pdfImages, pdfPages, docxText };
