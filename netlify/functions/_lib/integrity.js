// Guards against AI-written content the customer never provided.
// Runs on a tailoring result AFTER the AI call succeeded, and touches no license or credit state.
//   1. Facts (name, contact, employers, titles, dates, schools, certifications, awards) are restored from the
//      customer's own resume, so the AI cannot change or add them.
//   2. Rewritten lines are FLAGGED (never deleted) so the customer must confirm them when they bring in:
//        claims     numbers, leadership/supervisory wording, credential wording, praise or personality words
//                   ("exceptional", "motivated", "reliable"), attendance claims, or skills that are new;
//        details    two or more content words that appear nowhere in the customer's own answers.
//      A faithful paraphrase (the same facts in clearer words) brings in neither, so it is NOT flagged.
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

// Wording that claims responsibility, qualification or character. A match is only suspicious when the customer's own
// text does not already contain it (compared by word root, or by the whole phrase for multi-word claims).
const CLAIM_WORDS = [
  { label: 'leadership or supervisory wording', rootLen: 4, re: /\b(supervis\w*|manag\w*|led|leading|directed|oversaw|oversee\w*|mentor\w*|coach\w*|train(?:ed|ing|er|s)?)\b/gi },
  { label: 'credential or licence wording', rootLen: 4, re: /\b(certif\w*|licen[sc]\w*|accredit\w*|bachelor\w*|master'?s|mba|ph\.?d|degree|diploma|osha|cpr|cdl)\b/gi },
  { label: 'praise or personality claim', rootLen: 6, re: /\b(motivated|passionate|dynamic|results?-driven|driven|proven|exceptional\w*|excellen\w*|outstanding|expert\w*|extensive\w*|highly|successful\w*|award-winning|top-performing|seasoned|skilled|strong|dedicated|committed|reliab\w*|dependab\w*|hard-?working|detail-oriented|self-starter|team player|innovative|enthusias\w*|energetic|ambitious|diligent|proactive|accomplished|talented|trustworthy|friendly|punctual)\b/gi },
  { label: 'attendance claim', rootLen: 0, re: /\b(perfect attendance|never (?:missed|late|absent)|always on time|on-time|consistent attendance)\b/gi }
];
const rootOf = (w, len) => w.toLowerCase().replace(/[^a-z]/g, '').slice(0, len);

// ── faithful paraphrase vs new content ─────────────────────────────────────────────────────────────────────────
// Words that carry no claim of their own, so using them is never "new content": function words, and plain verbs
// people use when they restate what they did ("helped", "sorted", "greeted").
const STOP = new Set(('a an and the or but if so than that this these those with without for to of in on at by from as into onto over under about after before ' +
  'during while when where which who whom whose their our your his her its they them we you i me my it is are was were be been being am do does did done ' +
  'have has had having not no nor also each every all any some more most other such only own same very can could would should will may might must ' +
  'one two three four five six seven eight nine ten per daily weekly new old day days week weeks year years time times way ways part parts ' +
  'applicant candidate skill skills position role job jobs work seeking looking interested entry level moving into').split(' '));
const PLAIN_VERBS = new Set(('help assist support handle complete prepare organize maintain work operate use keep follow answer greet stock clean sort count pack load ' +
  'check record communicate collect deliver serve make take give set put get find carry move place arrange review report write read speak talk listen ' +
  'learn practice attend join visit offer provide show explain describe wipe stack ring process receive send respond ask').split(' '));
const stem = (w) => {
  let x = w.toLowerCase();
  if (x.length > 3) x = x.replace(/(ing|ed|es|ly|er|s)$/, '');
  x = x.replace(/([bdgmnprt])\1$/, '$1');                      // canned -> can, stopped -> stop
  return x.length > 4 ? x.replace(/(e|y)$/, '') : x;
};
const wordsOf = (text) => s(text).toLowerCase().match(/[a-z]{3,}/g) || [];
const stemSet = (text) => new Set(wordsOf(text).map(stem));

// Content words in `line` that the customer never used (and that are not plain function words or plain verbs).
function newContentWords(line, originalStems, skip = new Set()) {
  const out = [];
  wordsOf(line).forEach((w) => {
    const st = stem(w);
    if (STOP.has(w) || skip.has(w) || PLAIN_VERBS.has(st) || originalStems.has(st) || out.includes(w)) return;
    out.push(w);
  });
  return out;
}

// -> { claims: [reason...], details: [word...] }
function analyse(line, originalText, originalNumbers, originalStems) {
  const claims = [];
  const claimTokens = new Set();                                                                  // words already reported as claims
  const lower = s(originalText).toLowerCase();
  const nums = [...numbersIn(line)].filter((n) => !originalNumbers.has(n));
  if (nums.length) claims.push(`number not in your resume: ${nums.slice(0, 3).join(', ')}`);
  CLAIM_WORDS.forEach(({ label, rootLen, re }) => {
    const fresh = (s(line).match(re) || []).filter((w) => {
      if (!rootLen || /[\s-]/.test(w)) return !lower.includes(w.toLowerCase());                   // phrases: the phrase itself must be there
      const root = rootOf(w, rootLen);
      return !new RegExp(`\\b${root}`, 'i').test(originalText);
    });
    if (fresh.length) { claims.push(`${label}: “${fresh[0]}”`); fresh.forEach((f) => wordsOf(f).forEach((w) => claimTokens.add(w))); }
  });
  return { claims, details: newContentWords(line, originalStems, claimTokens) };
}

// Kept for callers that only want the list of reasons.
function reasonsFor(line, originalText, originalNumbers, originalStems) {
  const stems = originalStems || stemSet(originalText);
  const { claims, details } = analyse(line, originalText, originalNumbers, stems);
  const reasons = claims.slice();
  if (details.length >= 2) reasons.push(`new details not in your answers: ${details.slice(0, 3).map((d) => `“${d}”`).join(', ')}`);
  return reasons;
}

const FACT_FIELDS = {
  experience: ['title', 'company', 'location', 'start', 'end'],
  volunteer: ['title', 'organization', 'location', 'start', 'end'],
  projects: ['name']
};

// original = the resume the customer sent; output = the AI's tailored resume object.
// options.vocabulary: extra words the customer supplied (their stated goal). They count as the customer's own words for the
// "new details" test only; they never make a claim (leadership, credential, praise, number) count as supported.
function reconcile(original, output, options = {}) {
  const orig = isObj(original) ? original : {};
  const out = JSON.parse(JSON.stringify(isObj(output) ? output : {}));
  const originalText = allText(orig).join('\n');
  const originalNumbers = numbersIn(originalText);
  const originalLines = new Set(allText(orig).map((t) => t.trim()));
  const originalStems = stemSet(`${originalText}\n${s(options.vocabulary)}`);

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
  // A line is flagged for a CLAIM (something the customer must confirm is true) or for NEW DETAILS (two or more
  // content words the customer never used). A faithful paraphrase has neither, so it passes without a warning.
  const check = (text, where) => {
    const t = s(text).trim();
    if (!t || originalLines.has(t) || unverified.length >= 40) return;
    const { claims, details } = analyse(t, originalText, originalNumbers, originalStems);
    const reasons = claims.slice();
    if (details.length >= 2) reasons.push(`new details not in your answers: ${details.slice(0, 3).map((d) => `“${d}”`).join(', ')}`);
    if (reasons.length) unverified.push({ where, text: t, kind: claims.length ? 'claim' : 'details', reasons });
  };
  check(out.summary.tagline, 'summary.tagline');
  arr(out.summary.bullets).forEach((b, i) => check(b, `summary.bullets.${i}`));
  const origSkills = new Set(arr(orig.summary && orig.summary.skills).map((x) => s(x).trim().toLowerCase()));
  arr(out.summary.skills).forEach((sk, i) => {
    const t = s(sk).trim();
    if (!t || origSkills.has(t.toLowerCase()) || originalText.toLowerCase().includes(t.toLowerCase())) return;
    if (unverified.length < 40) unverified.push({ where: `summary.skills.${i}`, text: t, kind: 'claim', reasons: ['skill not found in your resume'] });
  });
  ['experience', 'volunteer', 'projects'].forEach((k) => arr(out[k]).forEach((e, i) => {
    if (!isObj(e)) return;
    arr(e.bullets).forEach((b, j) => check(b, `${k}.${i}.bullets.${j}`));
    check(e.summary, `${k}.${i}.summary`);
    check(e.description, `${k}.${i}.description`);
  }));

  return { resume: out, unverified };
}

module.exports = { reconcile, reasonsFor, analyse, newContentWords, stemSet, numbersIn };
