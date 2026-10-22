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

const Core = require('../../../resume-core.js');

const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
// Text only (plus plain numbers). An object, array, boolean or function is never content, and converting a hostile object (for example one
// with a non-function toString) must not be able to throw.
const s = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
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

// ── entry-scoped checks (AI Polish) ────────────────────────────────────────────────────────────────────────────────
// The checks above compare a line with the WHOLE resume, so a word that appears anywhere (an organization's name, a line in a
// different entry) counts as "the customer's own". That lets an AI move a detail from one entry into another unnoticed: a project
// that never mentioned families can gain "for families in the community" because a volunteer entry does. These checks compare a line
// only with the entry it belongs to. They add warnings only: nothing is reverted, deleted or charged differently, and Tailor does not
// use them (they run only when reconcile gets options.entryScope).
const PEOPLE = 'families|family|children|kids|students|seniors|elderly|patients|customers|clients|residents|neighbors|neighbours|community|public|veterans|homeless|shoppers|guests|visitors|parents|people in need|those in need|people';
const BENEFICIARY_RES = [
  new RegExp(`\\b(?:for|to|serv\\w*|support\\w*|benefit\\w*|help\\w*|feed\\w*|assist\\w*|aid\\w*)\\s+(?:(?:the|local|our|many|needy|hungry|low-income|underserved|neighborhood|their|his|her)\\s+)*(${PEOPLE})\\b`, 'gi'),
  /\b(?:in|within|across)\s+(?:the|our|their|a)\s+(?:local\s+)?(community|neighborhood|neighbourhood|city|town|area)\b/gi,
  /\b(?:community|neighborhood)\s+(members|residents|families)\b/gi
];
const OUTCOME_RE = /\b(resulting in|resulted in|leading to|led to|which (?:helped|allowed|ensured|made)|ensur(?:ing|ed)|so that|improv(?:ing|ed)|increas(?:ing|ed)|reduc(?:ing|ed)|sav(?:ing|ed)|boost(?:ing|ed)|streamlin\w*|enabl(?:ing|ed)|making a difference|made a difference|impact\w*|benefit(?:ing|ed|s)?)\b/gi;
// Verbs that claim ownership of a task, and verbs that keep the person in a supporting role.
const OWN_RE = /\b(organi[sz]\w*|plann(?:ed|ing)|plan|coordinat\w*|creat(?:ed|ing)|built|build(?:ing)?|design(?:ed|ing)?|develop(?:ed|ing)?|launch(?:ed|ing)?|establish(?:ed|ing)?|implement(?:ed|ing)?|initiat(?:ed|ing)|arrang(?:ed|ing)|orchestrat\w*|spearhead\w*|ran)\b/gi;
const HEDGE_RE = /\b(help(?:ed|ing|s)?|assist(?:ed|ing|s)?|support(?:ed|ing|s)?|participat\w*|contribut\w*|join(?:ed|ing)?|took part|take part|part of|worked (?:with|alongside)|pitched in|aided)\b/i;
const rootKey = (w) => { const x = w.toLowerCase(); if (/^plan/.test(x)) return 'plan'; if (/^buil/.test(x)) return 'build'; return x === 'ran' ? 'ran' : x.slice(0, 5); };
const hasRoot = (text, root) => new RegExp(`\\b${root.replace(/[^a-z]/g, '')}`, 'i').test(text);

// scope = { text: the entry's own original text, lines: its original lines, blank: the field was empty in the customer's answers,
//           stems: stems of the entry's own words (+ the customer's stated goal), globalStems: stems of the whole resume }
function scopedReasons(line, scope) {
  const reasons = [];
  if (!scope) return reasons;
  if (scope.blank) reasons.push('added where you wrote nothing: this part was blank in your answers');
  // A line identical to one of the customer's lines in a DIFFERENT entry has been copied across, however few of its words are new here.
  if (scope.foreign && scope.foreign.has(lineKey(line))) reasons.push('copied from a different part of your resume: this line belongs to another entry');
  // Content words this entry never used. If some of them are the customer's words from a DIFFERENT entry, the line has been
  // given details that belong elsewhere (a line copied between entries, or a word borrowed from another job or project).
  if (scope.stems && scope.globalStems) {
    const fresh = newContentWords(line, scope.stems);
    const borrowed = fresh.filter((w) => scope.globalStems.has(stem(w)));
    if (borrowed.length >= 1 && fresh.length >= 2) reasons.push(`details from a different part of your resume: ${borrowed.slice(0, 3).map((d) => `“${d}”`).join(', ')}`);
  }
  const seen = new Set();
  BENEFICIARY_RES.forEach((re) => { for (const m of s(line).matchAll(re)) {
    const who = m[1].toLowerCase(); const root = who.split(' ')[0].slice(0, 5);
    if (seen.has(root) || hasRoot(scope.text, root)) continue;
    seen.add(root); reasons.push(`who benefited is not in this entry: “${who}”`);
  } });
  for (const m of s(line).matchAll(OUTCOME_RE)) {
    const root = m[1].toLowerCase().split(' ')[0].slice(0, 5);
    if (seen.has(root) || hasRoot(scope.text, root)) continue;
    seen.add(root); reasons.push(`a result or impact that is not in this entry: “${m[1].toLowerCase()}”`);
  }
  if (!HEDGE_RE.test(line)) {
    for (const m of s(line).matchAll(OWN_RE)) {
      const key = rootKey(m[1]); if (seen.has(key)) continue;
      const withKey = scope.lines.filter((o) => [...o.matchAll(OWN_RE)].some((x) => rootKey(x[1]) === key));
      if (withKey.some((o) => !HEDGE_RE.test(o))) continue;              // the customer owns this task in their own words
      seen.add(key);
      reasons.push(withKey.length ? `your role changed: you wrote that you helped with this, but it now says “${m[1].toLowerCase()}”`
                                  : `a responsibility that is not in this entry: “${m[1].toLowerCase()}”`);
    }
  }
  return reasons;
}

// original = the resume the customer sent; output = the AI's tailored resume object.
// options.vocabulary: extra words the customer supplied (their stated goal). They count as the customer's own words for the
// "new details" test only; they never make a claim (leadership, credential, praise, number) count as supported.
function reconcile(original, output, options = {}) {
  const maxFlags = Number.isFinite(options.maxFlags) ? options.maxFlags : 40;
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
      if (options.keepBlankedText) {
        // Polish only (Tailor may legitimately condense an entry): a reply that blanks out text the customer wrote must
        // never erase it. Anything the AI actually wrote is kept as it is.
        ['summary', 'description'].forEach((f) => { if (s(entry[f]).trim() && !s(merged[f]).trim()) merged[f] = entry[f]; });
        if (arr(entry.bullets).some((b) => s(b).trim()) && !arr(merged.bullets).some((b) => s(b).trim())) merged.bullets = entry.bullets;
      }
      return merged;
    });                                                                  // entries the AI invented are dropped
  });
  if (!isObj(out.summary)) out.summary = isObj(orig.summary) ? orig.summary : { tagline: '', bullets: [], skills: [] };

  // 2. Flag unsupported lines.
  const unverified = [];
  // A line is flagged for a CLAIM (something the customer must confirm is true) or for NEW DETAILS (two or more
  // content words the customer never used). A faithful paraphrase has neither, so it passes without a warning.
  const check = (text, where, scope) => {
    const t = s(text).trim();
    // With the entry-scoped checks a line is "the customer's own" only if it is one of THIS entry's lines; a line that is identical
    // to a line of a different entry has been moved there, and is checked like any other.
    const known = options.entryScope && scope ? scope.lines : null;
    if (!t || (known ? known.includes(t) : originalLines.has(t)) || unverified.length >= maxFlags) return;
    const { claims, details } = analyse(t, originalText, originalNumbers, originalStems);
    const reasons = claims.slice();
    if (details.length >= 2) reasons.push(`new details not in your answers: ${details.slice(0, 3).map((d) => `“${d}”`).join(', ')}`);
    const scoped = options.entryScope ? scopedReasons(t, scope) : [];       // AI Polish only
    scoped.forEach((r) => reasons.push(r));
    if (reasons.length) unverified.push({ where, text: t, kind: claims.length || scoped.length ? 'claim' : 'details', reasons });
  };
  // Every line of the customer's resume, by entry, so a line can be recognised as having come from somewhere else.
  const linesByEntry = [];
  ['experience', 'volunteer', 'projects'].forEach((k) => arr(orig[k]).forEach((e, i) => { if (isObj(e)) linesByEntry.push({ k, i, keys: allText(e).map(lineKey).filter(Boolean) }); }));
  const topKeys = allText(isObj(orig.summary) ? orig.summary : {}).map(lineKey).filter(Boolean);
  const foreignOf = (k, i) => new Set(linesByEntry.filter((x) => !(x.k === k && x.i === i)).flatMap((x) => x.keys).concat(topKeys));
  const wholeScope = { text: originalText, lines: allText(orig).map((x) => s(x).trim()).filter(Boolean), blank: false, stems: originalStems, globalStems: originalStems };
  check(out.summary.tagline, 'summary.tagline', wholeScope);
  arr(out.summary.bullets).forEach((b, i) => check(b, `summary.bullets.${i}`, wholeScope));
  const origSkills = new Set(arr(orig.summary && orig.summary.skills).map((x) => s(x).trim().toLowerCase()));
  const origSkillKeys = new Set(arr(orig.summary && orig.summary.skills).map((x) => lineKey(x)).filter(Boolean));   // 'Teamwork.' is not a new skill
  arr(out.summary.skills).forEach((sk, i) => {
    const t = s(sk).trim();
    if (!t || origSkills.has(t.toLowerCase()) || origSkillKeys.has(lineKey(t)) || originalText.toLowerCase().includes(t.toLowerCase())) return;
    if (unverified.length < maxFlags) unverified.push({ where: `summary.skills.${i}`, text: t, kind: 'claim', reasons: ['skill not found in your resume'] });
  });
  ['experience', 'volunteer', 'projects'].forEach((k) => arr(out[k]).forEach((e, i) => {
    if (!isObj(e)) return;
    const o0 = isObj(arr(orig[k])[i]) ? arr(orig[k])[i] : {};
    const lines = allText(o0).map((x) => s(x).trim()).filter(Boolean);
    const entryStems = stemSet(`${lines.join('\n')}\n${s(options.vocabulary)}`);
    const scope = (blank) => ({ text: lines.join('\n'), lines, blank, stems: entryStems, globalStems: originalStems, foreign: foreignOf(k, i) });
    const hadBullets = arr(o0.bullets).some((b) => s(b).trim());
    arr(e.bullets).forEach((b, j) => check(b, `${k}.${i}.bullets.${j}`, scope(!hadBullets)));
    check(e.summary, `${k}.${i}.summary`, scope(!s(o0.summary).trim()));
    check(e.description, `${k}.${i}.description`, scope(!s(o0.description).trim()));
  }));

  return { resume: out, unverified };
}

// ── did the AI change anything the customer can see? ───────────────────────────────────────────────────────────────
// Compares the customer's answers with the result, line by line, and reports how many lines were
//   reworded  a real change in wording (different words, or a line added),
//   dropped   a line removed (not an improvement on its own, so it never counts toward a charge),
//   cosmetic  only capitals, punctuation or spacing differ,
//   unchanged identical.
// Observation only: it touches no license state, and what counts as "meaningful" is decided by the caller. Pure.
const textLines = (r) => {
  const c = isObj(r) ? r : {};
  const sm = isObj(c.summary) ? c.summary : {};
  const out = [{ where: 'summary.tagline', text: s(sm.tagline) }];
  arr(sm.bullets).forEach((b, i) => out.push({ where: `summary.bullets.${i}`, text: s(b) }));
  arr(sm.skills).forEach((b, i) => out.push({ where: `summary.skills.${i}`, text: s(b) }));
  ['experience', 'volunteer', 'projects'].forEach((k) => arr(c[k]).forEach((e, i) => {
    if (!isObj(e)) return;
    ['summary', 'description'].forEach((f) => { if (f in e) out.push({ where: `${k}.${i}.${f}`, text: s(e[f]) }); });
    arr(e.bullets).forEach((b, j) => out.push({ where: `${k}.${i}.bullets.${j}`, text: s(b) }));
  }));
  return out.filter((l) => l.text.trim());
};
const lineKey = (t) => s(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function assessChange(before, after) {
  const a = new Map(textLines(before).map((l) => [l.where, l.text.trim()]));
  const b = new Map(textLines(after).map((l) => [l.where, l.text.trim()]));
  const res = { reworded: 0, cosmetic: 0, unchanged: 0, dropped: 0 };
  new Set([...a.keys(), ...b.keys()]).forEach((where) => {
    const x = a.get(where); const y = b.get(where);
    if (y === undefined) res.dropped++;                                          // a line was removed: reported, but deleting text is not an improvement
    else if (x === undefined) res.reworded++;                                    // a line was added
    else if (x === y) res.unchanged++;
    else if (lineKey(x) === lineKey(y)) res.cosmetic++;
    else res.reworded++;
  });
  return res;
}

// ── the accepted result: guard, withhold, sanitise ──────────────────────────────────────────────────────────────────
// reconcile() FLAGS unsupported lines. guardResume() goes one step further and returns only what is accepted: every flagged line is put
// back to the customer's own wording (it is "withheld"), the result is re-checked until nothing is flagged, and only known resume fields
// survive (so an unexpected key or a non-text value from the AI never reaches the page, a PDF or a Word file).
// What was withheld is reported WITHOUT the AI's text, only where it was and why, so a withheld suggestion is never handed out for free.
const SECTION_NAME = { experience: 'Job', volunteer: 'Activity', projects: 'Project' };
const ENTRY_KEY = { experience: 'title', volunteer: 'title', projects: 'name' };

function describeWhere(orig, where) {
  const m = /^(experience|volunteer|projects)\.(\d+)\.(bullets|summary|description)(?:\.(\d+))?$/.exec(where);
  if (m) {
    const e = arr(orig[m[1]])[Number(m[2])] || {};
    const name = s(e[ENTRY_KEY[m[1]]]) || s(e.company) || s(e.organization) || `#${Number(m[2]) + 1}`;
    const part = m[3] === 'bullets' ? `bullet ${Number(m[4]) + 1}` : m[3] === 'summary' ? 'summary' : 'description';
    return `${SECTION_NAME[m[1]]}: ${name}, ${part}`;
  }
  if (where === 'summary.tagline') return 'Headline';
  if (/^summary\.bullets\./.test(where)) return 'Summary bullet';
  if (/^summary\.skills\./.test(where)) return 'Skills';
  return 'Resume';
}

// Putting ONE line back by position is only safe when the AI kept the lines in order. If it reordered them (Tailor does, on purpose) a
// positional revert would duplicate one of the customer's lines and lose another, so the whole group is put back instead.
const hasDuplicates = (list) => { const seen = new Set(); return arr(list).some((x) => { const k = lineKey(x); if (!k) return false; if (seen.has(k)) return true; seen.add(k); return false; }); };
function revertGroup(current, original, index, groupOnly) {
  const ob = arr(original);
  if (!groupOnly && arr(current).length === ob.length) {
    const trial = arr(current).slice(); trial[index] = ob[index];
    if (!hasDuplicates(trial)) return trial;
  }
  return JSON.parse(JSON.stringify(ob));
}

function withholdFlagged(orig, resume, unverified, options = {}) {
  const out = JSON.parse(JSON.stringify(resume));
  const withheld = [];
  const origSummary = isObj(orig.summary) ? orig.summary : {};
  if (!isObj(out.summary)) out.summary = { tagline: '', bullets: [], skills: [] };
  unverified.forEach((u) => {
    const w = s(u.where);
    let m;
    if (w === 'summary.tagline') out.summary.tagline = s(origSummary.tagline);
    else if ((m = /^summary\.bullets\.(\d+)$/.exec(w))) {
      out.summary.bullets = revertGroup(out.summary.bullets, origSummary.bullets, Number(m[1]), options.groupOnly);
    } else if (/^summary\.skills\.\d+$/.test(w)) {
      const keep = arr(out.summary.skills).filter((sk) => s(sk).trim() !== s(u.text).trim());
      const have = new Set(keep.map((x) => lineKey(x)));
      arr(origSummary.skills).forEach((sk) => { if (!have.has(lineKey(sk))) keep.push(sk); });        // never lose a skill the customer listed
      out.summary.skills = keep;
    } else if ((m = /^(experience|volunteer|projects)\.(\d+)\.bullets\.(\d+)$/.exec(w))) {
      const e = arr(out[m[1]])[Number(m[2])]; const o0 = arr(orig[m[1]])[Number(m[2])];
      if (isObj(e) && isObj(o0)) e.bullets = revertGroup(e.bullets, o0.bullets, Number(m[3]), options.groupOnly);
    } else if ((m = /^(experience|volunteer|projects)\.(\d+)\.(summary|description)$/.exec(w))) {
      const e = arr(out[m[1]])[Number(m[2])]; const o0 = arr(orig[m[1]])[Number(m[2])];
      if (isObj(e)) e[m[3]] = isObj(o0) ? s(o0[m[3]]) : '';
    }
    withheld.push({ where: w, label: describeWhere(orig, w), kind: u.kind, reasons: arr(u.reasons).map(s) });
  });
  return { resume: out, withheld };
}

// mode: 'polish' (also keeps text the AI blanked) or 'tailor'. options.vocabulary: the customer's stated goal.
// -> { resume (accepted, sanitised), withheld: [{ where, label, kind, reasons }] }
function guardResume(original, output, options = {}) {
  const orig = isObj(original) ? original : {};
  const base = { vocabulary: options.vocabulary, keepBlankedText: options.mode === 'polish', entryScope: true, maxFlags: 1000 };
  let current = output; const withheld = [];
  for (let pass = 0; pass < 4; pass++) {
    const r = reconcile(orig, current, base);
    if (!r.unverified.length) { current = r.resume; break; }
    const w = withholdFlagged(orig, r.resume, r.unverified, { groupOnly: options.mode === 'tailor' });
    withheld.push(...w.withheld); current = w.resume;
    if (pass === 3) current = JSON.parse(JSON.stringify(orig));          // cannot settle: fall back to the customer's own wording
  }
  // Keep only fields the resume model knows (drops unexpected keys, non-text values, empty rows).
  const resume = Core.clean(current);
  // Facts always come from the customer, whatever the AI sent.
  resume.name = s(orig.name).trim(); resume.contact = Core.clean({ contact: orig.contact }).contact;
  return { resume, withheld };
}

// ── Analyze: check the parsed resume against the text the customer pasted ───────────────────────────────────────────
// A parser should only move what the customer wrote into fields. Contact details and years that do not appear in the pasted text
// are invented, so they are removed (a wrong email on a resume is worse than a blank one). A number inside a bullet that the pasted
// text does not contain is kept but flagged, so the customer confirms it. Unknown fields and non-text values are dropped.
function groundAnalyzed(sourceText, parsed) {
  const src = s(sourceText);
  const lower = src.toLowerCase();
  const srcDigits = src.replace(/\D/g, '');
  const srcNumbers = numbersIn(src);
  const resume = Core.clean(parsed);
  const removed = [];
  const url = (x) => s(x).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  const c = resume.contact;
  if (c.email && !lower.includes(c.email.toLowerCase())) { c.email = ''; removed.push('email'); }
  if (c.phone && (c.phone.replace(/\D/g, '').length < 7 || !srcDigits.includes(c.phone.replace(/\D/g, '')))) { c.phone = ''; removed.push('phone'); }
  ['linkedin', 'website'].forEach((f) => { if (c[f] && !lower.includes(url(c[f]))) { c[f] = ''; removed.push(f); } });
  const years = (x) => (s(x).match(/\b\d{4}\b/g) || []);
  const grounded = (x) => years(x).every((y) => srcNumbers.has(y) || new RegExp(`['\u2019]\\s?${y.slice(2)}\\b`).test(src));   // "'19" in the text supports 2019
  ['experience', 'volunteer'].forEach((k) => resume[k].forEach((e) => ['start', 'end'].forEach((f) => { if (e[f] && !grounded(e[f])) { e[f] = ''; removed.push(`${k} ${f} date`); } })));
  resume.education.forEach((e) => { if (e.date && !grounded(e.date)) { e.date = ''; removed.push('education date'); } });
  resume.certifications.forEach((e) => { if (e.date && !grounded(e.date)) { e.date = ''; removed.push('certification date'); } });
  const unverified = [];
  const check = (text, where) => {
    const t = s(text).trim(); if (!t) return;
    const extra = [...numbersIn(t)].filter((n) => !srcNumbers.has(n));
    if (extra.length) unverified.push({ where, text: t, kind: 'claim', reasons: [`number not in the text you pasted: ${extra.slice(0, 3).join(', ')}`] });
  };
  resume.summary.bullets.forEach((b, i) => check(b, `summary.bullets.${i}`));
  check(resume.summary.tagline, 'summary.tagline');
  ['experience', 'volunteer', 'projects'].forEach((k) => resume[k].forEach((e, i) => {
    arr(e.bullets).forEach((b, j) => check(b, `${k}.${i}.bullets.${j}`));
    check(e.summary, `${k}.${i}.summary`); check(e.description, `${k}.${i}.description`);
  }));
  return { resume, unverified, removed };
}

module.exports = { reconcile, reasonsFor, analyse, newContentWords, stemSet, numbersIn, assessChange, scopedReasons, guardResume, withholdFlagged, groundAnalyzed };
