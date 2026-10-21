// Guards against AI-written content the customer never provided.
// Runs on a tailoring result AFTER the AI call succeeded, and touches no license or credit state.
//   1. Facts (name, contact, employers, titles, dates, schools, certifications, awards) are restored from the
//      customer's own resume, so the AI cannot change or add them.
//   2. Rewritten lines that bring in numbers, leadership wording or credential wording that appear nowhere in the
//      original resume, and skills that are new, are FLAGGED (not deleted) so the customer must confirm them.
// Pure functions: unit-tested without a database or the AI provider.

const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const s = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = (a) => (Array.isArray(a) ? a : []);

function allText(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allText(x, out));
  else if (isObj(v)) Object.keys(v).forEach((k) => allText(v[k], out));
  return out;
}

// Spelled-out numbers count too ("eight years" in the original makes "8 years" supported).
const WORD_NUMBERS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
const numbersIn = (text) => {
  const t = s(text);
  const found = new Set((t.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, '')));
  (t.toLowerCase().match(/[a-z]+/g) || []).forEach((w) => { if (Object.prototype.hasOwnProperty.call(WORD_NUMBERS, w)) found.add(String(WORD_NUMBERS[w])); });
  return found;
};

// Wording that claims responsibility or qualification. A match is only suspicious when its root is absent from the original.
const CLAIM_WORDS = [
  { label: 'leadership or supervisory wording', re: /\b(supervis\w*|manag\w*|led|leading|directed|oversaw|oversee\w*|mentor\w*|coach\w*)\b/gi },
  { label: 'credential or licence wording', re: /\b(certif\w*|licen[sc]\w*|accredit\w*|bachelor\w*|master'?s|mba|ph\.?d|degree|diploma|osha|cpr|cdl)\b/gi }
];
const rootOf = (w) => w.toLowerCase().replace(/[^a-z]/g, '').slice(0, 4);

function reasonsFor(line, originalText, originalNumbers) {
  const reasons = [];
  const nums = [...numbersIn(line)].filter((n) => !originalNumbers.has(n));
  if (nums.length) reasons.push(`number not in your resume: ${nums.slice(0, 3).join(', ')}`);
  CLAIM_WORDS.forEach(({ label, re }) => {
    const fresh = (s(line).match(re) || []).filter((w) => !new RegExp(`\\b${rootOf(w)}`, 'i').test(originalText));
    if (fresh.length) reasons.push(`${label}: “${fresh[0]}”`);
  });
  return reasons;
}

const FACT_FIELDS = {
  experience: ['title', 'company', 'location', 'start', 'end'],
  volunteer: ['title', 'organization', 'location', 'start', 'end'],
  projects: ['name']
};

// original = the resume the customer sent; output = the AI's tailored resume object.
function reconcile(original, output, options = {}) {
  const orig = isObj(original) ? original : {};
  const out = JSON.parse(JSON.stringify(isObj(output) ? output : {}));
  const originalText = allText(orig).join('\n');
  const originalNumbers = numbersIn(originalText);
  const originalLines = new Set(allText(orig).map((t) => t.trim()));

  // 1. Restore facts.
  out.name = orig.name;
  out.contact = orig.contact;
  ['education', 'certifications', 'awards'].forEach((k) => { out[k] = orig[k] === undefined ? [] : orig[k]; });
  Object.keys(FACT_FIELDS).forEach((k) => {
    const o = arr(orig[k]);
    const t = arr(out[k]);
    out[k] = o.map((entry, i) => {
      if (!isObj(entry)) return entry;
      if (!isObj(t[i])) return entry;                                    // the AI dropped it: keep the original
      const merged = { ...t[i] };
      FACT_FIELDS[k].forEach((f) => { merged[f] = entry[f]; });
      if (!Array.isArray(merged.bullets) && Array.isArray(entry.bullets)) merged.bullets = entry.bullets;
      return merged;
    });                                                                  // entries the AI invented are dropped
  });
  if (!isObj(out.summary)) out.summary = isObj(orig.summary) ? orig.summary : { tagline: '', bullets: [], skills: [] };

  // 2. Flag unsupported lines.
  const unverified = [];
  // `always` (summary lines when the AI wrote the summary): even without a suspicious number or word, an
  // AI-authored description of the person must be confirmed by them.
  const check = (text, where, always) => {
    const t = s(text).trim();
    if (!t || originalLines.has(t) || unverified.length >= 40) return;
    const reasons = reasonsFor(t, originalText, originalNumbers);
    if (!reasons.length && always) reasons.push('written by AI: confirm this describes you');
    if (reasons.length) unverified.push({ where, text: t, reasons });
  };
  check(out.summary.tagline, 'summary.tagline', options.flagNewSummary);
  arr(out.summary.bullets).forEach((b, i) => check(b, `summary.bullets.${i}`, options.flagNewSummary));
  const origSkills = new Set(arr(orig.summary && orig.summary.skills).map((x) => s(x).trim().toLowerCase()));
  arr(out.summary.skills).forEach((sk, i) => {
    const t = s(sk).trim();
    if (!t || origSkills.has(t.toLowerCase()) || originalText.toLowerCase().includes(t.toLowerCase())) return;
    if (unverified.length < 40) unverified.push({ where: `summary.skills.${i}`, text: t, reasons: ['skill not found in your resume'] });
  });
  ['experience', 'volunteer', 'projects'].forEach((k) => arr(out[k]).forEach((e, i) => {
    if (!isObj(e)) return;
    arr(e.bullets).forEach((b, j) => check(b, `${k}.${i}.bullets.${j}`));
    check(e.summary, `${k}.${i}.summary`);
    check(e.description, `${k}.${i}.description`);
  }));

  return { resume: out, unverified };
}

module.exports = { reconcile, reasonsFor, numbersIn };
