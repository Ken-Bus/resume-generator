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
  { label: 'leadership or supervisory wording', rootLen: 4, re: /\b(supervis\w*|manag\w*|led|leading|directed|oversaw|oversee\w*|mentor\w*|coach\w*|train(?:ed|ing|er|s)?|teach\w*|taught|tutor\w*|instruct\w*)\b/gi },
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
  'applicant candidate skill skills position role job jobs work seeking looking interested entry level moving into ' +
  'through throughout across between among around within upon via until since toward towards along near against beyond behind beside off out up down back ' +
  'just then once both either neither yet because although however therefore there here again too even still already often always usually while whenever ' +
  'what whatever whom how why whether').split(' '));
const PLAIN_VERB_WORDS = (('help assist support handle complete prepare organize maintain work operate use keep follow answer greet stock clean sort count pack load ' +
  'check record communicate collect deliver serve make take give set put get find carry move place arrange review report write read speak talk listen ' +
  'learn practice attend join visit offer provide show explain describe wipe stack ring process receive send respond ask ' +
  'welcome restock teach taught tidy scan bag label price sell sold assemble demonstrate showed kept wrote told made took gave found').split(' '));
// Irregular past forms are the same word ("drove" is "drive"). "led", "built", "ran" and "won" are left out on purpose: they claim leadership,
// ownership or an award and are judged separately.
const IRREGULAR = { drove: 'drive', driven: 'drive', wrote: 'write', written: 'write', kept: 'keep', sold: 'sell', taught: 'teach', made: 'make', took: 'take', taken: 'take', gave: 'give', given: 'give',
  found: 'find', held: 'hold', brought: 'bring', bought: 'buy', caught: 'catch', fed: 'feed', got: 'get', had: 'have', met: 'meet', paid: 'pay', sent: 'send', spoke: 'speak', stood: 'stand', told: 'tell',
  swept: 'sweep', dealt: 'deal', sat: 'sit', did: 'do', done: 'do', went: 'go', came: 'come', saw: 'see', knew: 'know', chose: 'choose', began: 'begin', lost: 'lose', left: 'leave', put: 'put', read: 'read' };
// Word forms that do not follow the suffix rules (people/person, shelves/shelf, babysat/babysit...).
Object.assign(IRREGULAR, { children: 'child', people: 'person', persons: 'person', shelves: 'shelf', knives: 'knife', loaves: 'loaf', men: 'man', women: 'woman', babysat: 'babysit', rang: 'ring', learnt: 'learn' });
// One inflection ending is removed, then one agent/adverb ending, so "orders", "ordered" and "order" meet, and so do "carry", "carried" and
// "carries" (-y/-ied/-ies), "close" and "closed", "process" and "processed" (a final -s after s, u or i is part of the word, not a plural).
const stem = (w) => {
  let x = w.toLowerCase(); if (IRREGULAR[x]) x = IRREGULAR[x];
  if (x.length > 4 && /(ies|ied)$/.test(x)) x = `${x.slice(0, -3)}y`;                             // carried, carries -> carry
  else if (x.length > 3) {
    const m = /(ing|ed|es|s)$/.exec(x);
    if (m) {
      const base = x.slice(0, -m[1].length);
      if (m[1] === 's') { if (!/(s|u|i)$/.test(base)) x = base; }                                 // orders -> order; process, bus, status stay
      else if (m[1] === 'es') x = /(s|x|z|ch|sh|o)$/.test(base) ? base : x.slice(0, -1);          // boxes -> box, dishes -> dish, closes -> close
      else x = base;                                                                              // loading -> load, loaded -> load
    }
  }
  if (x.length > 4) x = x.replace(/(er|ly)$/, '');                                               // workers -> work, orders -> ord (as before)
  x = x.replace(/([bdgmnprt])\1$/, '$1');                                                        // canned -> can, stopped -> stop
  return x.length > 4 ? x.replace(/(e|y)$/, '') : x;
};
// The list above is in base form; compare by stem, as the customer's words are ("organized" must match "organize").
const PLAIN_VERBS = new Set([...PLAIN_VERB_WORDS, ...PLAIN_VERB_WORDS.map(stem)]);
let NEUTRAL_STEMS = null;     // built once NEUTRAL exists (below)
const wordsOf = (text) => s(text).toLowerCase().match(/[a-z]{3,}/g) || [];
// Two words written apart in the answers support the same two joined ("hair cut" -> "haircut", "paper work" -> "paperwork", "play ground" -> "playground").
const stemSet = (text) => { const w = wordsOf(text); const set = new Set(w.map(stem)); for (let i = 0; i + 1 < w.length; i++) set.add(stem(w[i] + w[i + 1])); return set; };

// Plain nouns that name no particular fact: they replace a vague word ("stuff", "things") or restate the work. A line gaining one of them gains no
// new claim. (Who benefited, where and how well are judged elsewhere.)
const NEUTRAL = new Set('product products item items thing things task tasks duty duties supply supplies material materials goods merchandise equipment person people persons orders order area areas'.split(' '));
// Words that mean the same as one the customer wrote, in a resume.
const SAME_AS = { accurate: ['correct', 'right'], customer: ['customers'], store: ['shop'], shop: ['store'], assist: ['help'],
  // the same word in another common form, or its everyday abbreviation (an honest edit may write either way round)
  children: ['kids', 'kid', 'child'], child: ['kid', 'kids'], kids: ['children', 'child'], kid: ['child', 'children'],
  home: ['house'], homes: ['houses', 'house'], house: ['home'], houses: ['homes', 'home'], occasionally: ['sometimes'], sometimes: ['occasionally'],
  afterward: ['after'], afterwards: ['after'], entered: ['entry'], enter: ['entry'], entering: ['entry'],
  employees: ['workers', 'worker', 'employee'], employee: ['worker', 'employees'], workers: ['employees', 'employee'], worker: ['employee', 'employees'],
  temperature: ['temp', 'temps'], vegetables: ['veggies', 'veggie', 'veg'], substitute: ['sub', 'subs'], medications: ['meds', 'med'], medication: ['meds', 'med'], refrigerator: ['fridge'], photographs: ['photos'],
  fix: ['correct', 'repair'], correct: ['accurate', 'right', 'fix'], supervised: ['supervision', 'supervisor'], arrive: ['come'],
  graduate: ['grad'], graduates: ['grad'], years: ['yrs', 'yr'], year: ['yr'], department: ['dept'], information: ['info'], appointment: ['appt'], appointments: ['appts', 'appt'], quantity: ['qty'] };
NEUTRAL_STEMS = new Set([...NEUTRAL, ...[...NEUTRAL].map(stem)]);
// A word the customer's plain shorthand obviously refers to ("stock" -> shelves).
const IMPLIED_BY = { shelv: ['stock'], shelf: ['stock'] };
// "used" -> "us" but "use" -> "use": a stem also matches with a final e added or removed.
const known = (set, st) => set.has(st) || set.has(`${st}e`) || (st.endsWith('e') && set.has(st.slice(0, -1)));

// Content words in `line` that the customer never used (and that are not plain function words or plain verbs).
function newContentWords(line, originalStems, skip = new Set()) {
  const out = [];
  wordsOf(line).forEach((w) => {
    const st = stem(w);
    if (STOP.has(w) || skip.has(w) || known(PLAIN_VERBS, st) || known(originalStems, st) || out.includes(w)) return;
    if (known(NEUTRAL_STEMS, st) || (SAME_AS[w] || []).some((x) => known(originalStems, stem(x))) || (IMPLIED_BY[st] || []).some((x) => known(originalStems, stem(x)))) return;
    out.push(w);
  });
  return out;
}

// -> { claims: [reason...], details: [word...] }
const TEACH_RE = /\b(train(?:ed|ing|er|s)?|teach\w*|taught|tutor\w*|instruct\w*)\b/i;
// "Helped train new employees" is a faithful restatement of "Helped new workers learn ..." : training someone is the same help, said plainly. It is
// accepted only when the line is hedged (helped / assisted / supported ...) AND the entry itself speaks of learning, teaching, showing or new people.
// The entry itself already speaks of showing, teaching or training someone, so teaching is not a new claim.
const TEACH_SAID_RE = /\b(show(?:s|ed|ing|n)?|teach\w*|taught|train(?:ed|ing|er|s)?|instruct\w*|orient(?:ed|ing|ation)?|explain\w*|tutor\w*)\b/i;
const TRAIN_BASIS_RE = /\b(learn\w*|teach\w*|taught|show(?:s|ed|ing|n)?|orient(?:ed|ing|ation)?|explain\w*|new (?:workers?|employees?|hires?|staff|team ?members?|co-?workers?|people|folks|volunteers?|associates?|students?|kids|children))\b/i;
function analyse(line, originalText, originalNumbers, originalStems, localText) {
  const claims = [];
  const claimTokens = new Set();                                                                  // words already reported as claims
  const lower = s(originalText).toLowerCase();
  const nums = [...numbersIn(line)].filter((n) => !originalNumbers.has(n));
  if (nums.length) claims.push(`number not in your resume: ${nums.slice(0, 3).join(', ')}`);
  CLAIM_WORDS.forEach(({ label, rootLen, re }) => {
    const fresh = (s(line).match(re) || []).filter((w) => {
      if (TEACH_RE.test(w)) {
        const local = s(localText !== undefined ? localText : originalText);
        if (TEACH_SAID_RE.test(local)) return false;                                              // "showed new people how to ..." -> "Taught new people to ..."
        if (/^train/i.test(w) && HEDGE_RE.test(line) && TRAIN_BASIS_RE.test(local)) { claimTokens.add(w.toLowerCase()); return false; }   // "helped train", said of people who learned
      }
      if (!rootLen || /[\s-]/.test(w)) return !lower.includes(w.toLowerCase());                   // phrases: the phrase itself must be there
      const root = rootOf(w, rootLen);
      if (TEACH_RE.test(w) && TEACH_RE.test(s(originalText))) return false;                      // train / teach / taught / tutor / instruct are one kind of claim
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
const BENE_SYN = { child: ['kid'], kids: ['child'], kid: ['child'] };      // 'kids' in the answers supports 'children' in the edit
const hasBeneRoot = (text, root) => hasRoot(text, root) || (BENE_SYN[root] || []).some((r) => hasRoot(text, r));

// scope = { text: the entry's own original text, lines: its original lines, blank: the field was empty in the customer's answers,
//           stems: stems of the entry's own words (+ the customer's stated goal), globalStems: stems of the whole resume }
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
// A misspelling of a word the customer wrote: close as written ("registar" / "register"), or close once endings are removed ("recieve" / "received").
const closeBy = (a, b) => a.length >= 5 && b.length >= 5 && Math.abs(a.length - b.length) <= 1 && lev(a, b) <= 2;
const nearSpelling = (w, o) => closeBy(w, o) || closeBy(stem(w), stem(o));

// How often something was done is a fact. "daily", "every day", "weekly" are plain words (so the new-word test lets them through), but a
// frequency the entry never stated is invented.
const FREQ = [
  [/\b(daily|every day|each day|per day|a day)\b/gi, /\b(daily|day|days)\b/i, 'daily'],
  [/\b(weekly|every week|each week|per week|a week)\b/gi, /\b(weekly|week|weeks)\b/i, 'weekly'],
  [/\b(monthly|every month|each month|per month)\b/gi, /\b(monthly|month|months)\b/i, 'monthly'],
  [/\b(nightly|every night|each night)\b/gi, /\b(nightly|night|nights)\b/i, 'nightly'],
  [/\b(hourly|every hour|each hour|per hour)\b/gi, /\b(hourly|hour|hours)\b/i, 'hourly'],
  [/\b(every shift|each shift|per shift)\b/gi, /\b(shift|shifts)\b/i, 'every shift']
];
function scopedReasons(line, scope) {
  const reasons = [];
  if (!scope) return reasons;
  if (scope.blank) reasons.push('added where you wrote nothing: this part was blank in your answers');
  // A line identical to one of the customer's lines in a DIFFERENT entry has been copied across, however few of its words are new here.
  if (scope.foreign && scope.foreign.has(lineKey(line))) reasons.push('copied from a different part of your resume: this line belongs to another entry');
  // Content words this entry never used. If some of them are the customer's words from a DIFFERENT entry, the line has been
  // given details that belong elsewhere (a line copied between entries, or a word borrowed from another job or project).
  const trainOk = HEDGE_RE.test(line) && TRAIN_BASIS_RE.test(s(scope.text));                          // "helped train" for people who learned
  const skip = new Set(trainOk ? wordsOf(line).filter((w) => /^train/.test(w)) : []);
  if (scope.stems && scope.globalStems) {
    const fresh = newContentWords(line, scope.stems, skip);
    const borrowed = fresh.filter((w) => scope.globalStems.has(stem(w)));
    if (borrowed.length >= 1 && fresh.length >= 2) reasons.push(`details from a different part of your resume: ${borrowed.slice(0, 3).map((d) => `“${d}”`).join(', ')}`);
  }
  // ONE new content word is enough to add a fact ("safely", "refunds", "hazards", "discrepancies"), so in AI Polish a word that this entry never
  // used is a reason to withhold the line. A corrected spelling of a word the customer wrote ("recieve" -> "received") is not a new word.
  if (scope.stems && scope.words) {
    const fresh = newContentWords(line, scope.stems, skip).filter((w) => !scope.words.some((o) => nearSpelling(w, o)));
    if (fresh.length === 1) reasons.push(`a new detail that is not in this entry: “${fresh[0]}”`);
  }
  FREQ.forEach(([re, evidence, label]) => { if (s(line).match(re) && !evidence.test(scope.text)) reasons.push(`how often is not in this entry: “${label}”`); });
  const seen = new Set();
  BENEFICIARY_RES.forEach((re) => { for (const m of s(line).matchAll(re)) {
    const who = m[1].toLowerCase(); const root = who.split(' ')[0].slice(0, 5);
    if (seen.has(root) || hasBeneRoot(scope.text, root) || wordsOf(scope.text).some((o) => nearSpelling(who.split(' ')[0], o))) continue;      // 'custmers' in THIS entry's own text supports 'customers' (the customer's stated goal never supports a beneficiary)
    seen.add(root); reasons.push(`who benefited is not in this entry: “${who}”`);
  } });
  for (const m of s(line).matchAll(OUTCOME_RE)) {
    const root = m[1].toLowerCase().split(' ')[0].slice(0, 5);
    if (seen.has(root) || hasRoot(scope.text, root)) continue;
    seen.add(root); reasons.push(`a result or impact that is not in this entry: “${m[1].toLowerCase()}”`);
  }
  // Checking the work of the person who supervised you is a change of role, and so is ordering what the customer only reported ("tell my boss when we run low").
  const REVERSAL_RE = /\b(?:check|review|inspect|audit|approv|verif)\w*\s+(?:the\s+)?(?:pharmacist|manager|supervisor|boss|nurse|doctor|teacher|owner|chef|lead|trainer|foreman)(?:'s|s')?\s+(?:work|orders?|decisions?)\b/i;
  const ORDER_VERB_RE = /(?:^|\band\s|,\s*)(order(?:ed|ing)?)\b(?=\s+(?:the\s+)?(?:more|new|extra|supplies|food|stock|inventory|parts|materials|products|items|equipment|replacements?)\b)/i;
  if (REVERSAL_RE.test(s(line)) && !REVERSAL_RE.test(scope.text)) reasons.push(`a bigger role than you described: “${s(line).match(REVERSAL_RE)[0].toLowerCase()}”`);
  if (ORDER_VERB_RE.test(s(line)) && !ORDER_VERB_RE.test(scope.text)) reasons.push('a responsibility that is not in this entry: “order”');
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
  const originalWords = wordsOf(`${originalText}\n${s(options.vocabulary)}`);

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
  // "4 years of experience" restates a duration the customer gave ("4 years"): the word "experience" there is not a new detail. ("Experienced" alone still is.)
  const hasDuration = /\b(years?|yrs?)\b/i.test(originalText);
  const plainDuration = (line) => (hasDuration ? line.replace(/\b((?:\d+|[a-z]+)\s+(?:years?|yrs?)\s+of\s+)experience\b/gi, '$1') : line);
  const check = (text, where, scope) => {
    const raw = s(text).trim(); const t = plainDuration(raw);
    // With the entry-scoped checks a line is "the customer's own" only if it is one of THIS entry's lines; a line that is identical
    // to a line of a different entry has been moved there, and is checked like any other.
    const known = options.entryScope && scope ? scope.lines : null;
    if (!raw || (known ? known.includes(raw) : originalLines.has(raw)) || unverified.length >= maxFlags) return;
    const analysed = analyse(t, originalText, originalNumbers, originalStems, options.entryScope && scope ? scope.text : undefined);
    const claims = analysed.claims;
    // A corrected spelling of a word the customer wrote ("custmers" -> "customers") is the customer's own word, however many are fixed in one line.
    const ownWords = (options.entryScope && scope && scope.words) || originalWords;
    const details = analysed.details.filter((w) => !ownWords.some((o) => nearSpelling(w, o)));
    const reasons = claims.slice();
    if (details.length >= 2) reasons.push(`new details not in your answers: ${details.slice(0, 3).map((d) => `“${d}”`).join(', ')}`);
    const scoped = options.entryScope ? scopedReasons(t, scope) : [];       // AI Polish only
    scoped.forEach((r) => reasons.push(r));
    if (reasons.length) unverified.push({ where, text: raw, kind: claims.length || scoped.length ? 'claim' : 'details', reasons });
  };
  // Every line of the customer's resume, by entry, so a line can be recognised as having come from somewhere else.
  const linesByEntry = [];
  ['experience', 'volunteer', 'projects'].forEach((k) => arr(orig[k]).forEach((e, i) => { if (isObj(e)) linesByEntry.push({ k, i, keys: allText(e).map(lineKey).filter(Boolean) }); }));
  const topKeys = allText(isObj(orig.summary) ? orig.summary : {}).map(lineKey).filter(Boolean);
  const foreignOf = (k, i) => new Set(linesByEntry.filter((x) => !(x.k === k && x.i === i)).flatMap((x) => x.keys).concat(topKeys));
  const wholeScope = { text: originalText, lines: allText(orig).map((x) => s(x).trim()).filter(Boolean), blank: false, stems: originalStems, words: originalWords, globalStems: originalStems };   // `words` makes ONE new content word in the headline or a summary line a reason to withhold it, as in a job entry
  check(out.summary.tagline, 'summary.tagline', wholeScope);
  arr(out.summary.bullets).forEach((b, i) => check(b, `summary.bullets.${i}`, wholeScope));
  const origSkills = new Set(arr(orig.summary && orig.summary.skills).map((x) => s(x).trim().toLowerCase()));
  const origSkillKeys = new Set(arr(orig.summary && orig.summary.skills).map((x) => lineKey(x)).filter(Boolean));   // 'Teamwork.' is not a new skill
  // The AI may correct, tidy or re-case the skills the customer LISTED, but it may not add one ("Skills: fix spelling and capitals and remove exact
  // repeats; never add a skill"). A skill is therefore supported only by the customer's own skills list, never by their goal or headline ("want to
  // move into dispatch" says where they are headed, not what they can do) and not by a job description either: a skill the customer never listed is
  // a claim for them to make themselves. The same words with a spelling or form fixed ("costumer service" -> "Customer service", "work hard" ->
  // "Hard worker") are the customer's own skill.
  const skillText = arr(orig.summary && orig.summary.skills).map(s).join('\n');
  const skillStems = stemSet(skillText); const skillWords = wordsOf(skillText);
  const supportedSkill = (t) => {
    const a = analyse(t, skillText, numbersIn(skillText), skillStems);
    return !a.claims.length && !a.details.filter((w) => !skillWords.some((o) => nearSpelling(w, o))).length;
  };
  arr(out.summary.skills).forEach((sk, i) => {
    const t = s(sk).trim();
    if (!t || origSkills.has(t.toLowerCase()) || origSkillKeys.has(lineKey(t)) || supportedSkill(t)) return;
    if (unverified.length < maxFlags) unverified.push({ where: `summary.skills.${i}`, text: t, kind: 'claim', reasons: ['skill not found in your resume'] });
  });
  ['experience', 'volunteer', 'projects'].forEach((k) => arr(out[k]).forEach((e, i) => {
    if (!isObj(e)) return;
    const o0 = isObj(arr(orig[k])[i]) ? arr(orig[k])[i] : {};
    const lines = allText(o0).map((x) => s(x).trim()).filter(Boolean);
    const entryStems = stemSet(`${lines.join('\n')}\n${s(options.vocabulary)}`);
    const entryWords = wordsOf(`${lines.join('\n')}\n${s(options.vocabulary)}`);
    const scope = (blank) => ({ text: lines.join('\n'), lines, blank, stems: entryStems, words: entryWords, globalStems: originalStems, foreign: foreignOf(k, i) });
    const hadBullets = arr(o0.bullets).some((b) => s(b).trim());
    arr(e.bullets).forEach((b, j) => check(b, `${k}.${i}.bullets.${j}`, scope(!hadBullets)));
    check(e.summary, `${k}.${i}.summary`, scope(!s(o0.summary).trim()));
    check(e.description, `${k}.${i}.description`, scope(!s(o0.description).trim()));
  }));

  return { resume: out, unverified };
}

// ── did the AI change anything the customer can see? ───────────────────────────────────────────────────────────────
// Compares the customer's answers with the result, line by line, and reports how many lines were
//   reworded  a real rewrite (see classifyEdit), or a line added,
//   minor     a one-word or filler-only touch-up: observed, never charged,
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

// Word-level difference between two lines (lower-case words, punctuation ignored). diffHunks lists every separate place the line changed:
// { del: words only in `a`, ins: words only in `b`, at: index of the hunk in `a`'s words }. Longest-common-subsequence based; lines are short.
function diffHunks(x, y) {
  const a = lineKey(x).split(' ').filter(Boolean); const b = lineKey(y).split(' ').filter(Boolean);
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const hunks = []; let cur = null; let i = 0; let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { cur = null; i++; j++; continue; }
    if (!cur) { cur = { del: [], ins: [], at: i }; hunks.push(cur); }
    if (j >= b.length || (i < a.length && L[i + 1][j] >= L[i][j + 1])) cur.del.push(a[i++]); else cur.ins.push(b[j++]);
  }
  return { hunks, a, b };
}
// The words only in `a` (del), only in `b` (ins), and how many separate places the line changed (hunks).
function wordDiff(x, y) {
  const { hunks } = diffHunks(x, y);
  return { del: hunks.flatMap((h) => h.del), ins: hunks.flatMap((h) => h.ins), hunks: hunks.length };
}

// What KIND of change is this line edit? (two different lines; the caller has already handled identical text)
//   cosmetic  only capitals, punctuation or spacing differ
//   minor     a touch-up that is not worth a generation: ONE word added, removed or swapped in one place, or only filler words
//             ("and", "more", "with"...) changed. "Helped organize food" -> "Helped organize donated food" is minor.
//   rewrite   anything else: two or more separate edits, a reordered or restructured sentence, several words replaced, a new line.
// There is no length or word-count cut-off on the line: the test is the SHAPE of the edit, so the same edit is always judged the same way.
function classifyEdit(x, y) {
  if (lineKey(x) === lineKey(y)) return 'cosmetic';
  const d = wordDiff(x, y);
  if (d.hunks === 1 && d.del.length <= 1 && d.ins.length <= 1) return 'minor';
  if (d.del.concat(d.ins).every((w) => STOP.has(w))) return 'minor';
  return 'rewrite';
}

// Lines are matched by CONTENT inside their group (one entry's bullets, the skills list, a single field), not by position, so deleting a
// duplicate in the middle of a list, or the AI re-ordering a list, does not make the following lines look rewritten.
//   1. identical text pairs up first, then text identical except capitals/punctuation/spacing,
//   2. each remaining new line pairs with the remaining old line it shares the most words with (nothing shared = a new line),
//   3. old lines nobody pairs with are `dropped`.
const groupOf = (where) => where.replace(/\.\d+$/, '');
const byGroup = (lines) => { const m = new Map(); lines.forEach((l) => { const g = groupOf(l.where); if (!m.has(g)) m.set(g, []); m.get(g).push(l.text.trim()); }); return m; };
// How many words two lines share. A misspelling and its correction, or two forms of one word, count as the same word: otherwise a one-word line
// ("paperwerk" -> "Paperwork", a skill) would look like a brand-new line instead of the customer's own line corrected.
const shared = (x, y) => {
  const d = wordDiff(x, y); let n = Math.max(lineKey(x).split(' ').length - d.del.length, 0); const pool = d.ins.slice();
  d.del.forEach((w) => { const k = pool.findIndex((v) => nearSpelling(w, v) || stem(w) === stem(v)); if (k >= 0) { pool.splice(k, 1); n++; } });
  return n;
};

// Every line of the comparison as an item: { kind, a (old text), b (new text) } with kind unchanged | cosmetic | minor | rewrite | added | dropped.
// An `added` item also says whether it is a SPLIT of an existing line (all its content words come from one old line of the group), and a `dropped`
// item whether it was a REPEAT (its content is still present in the group's new lines). assessChange counts them; the proposal in
// docs/PROPOSAL_COLLECTIVE_CHARGING.md would weigh them. Pure.
function changeItems(before, after) {
  const ga = byGroup(textLines(before)); const gb = byGroup(textLines(after));
  const items = [];
  new Set([...ga.keys(), ...gb.keys()]).forEach((g) => {
    const olds = (ga.get(g) || []).map((text) => ({ text, used: false })); const news = (gb.get(g) || []).map((text) => ({ text, used: false }));
    const pair = (match, kind) => news.forEach((n) => { if (n.used) return; const o = olds.find((x) => !x.used && match(x.text, n.text)); if (o) { o.used = n.used = true; items.push({ kind, a: o.text, b: n.text, group: g }); } });
    pair((x, y) => x === y, 'unchanged');
    pair((x, y) => lineKey(x) === lineKey(y), 'cosmetic');
    news.forEach((n) => {
      if (n.used) return;
      let best = null; let bestShared = 0;
      olds.forEach((o) => { if (o.used) return; const sh = shared(o.text, n.text); if (sh > bestShared) { best = o; bestShared = sh; } });
      n.used = true;
      if (!best) { const have = new Set(olds.flatMap((o) => contentStems(o.text))); const need = contentStems(n.text); items.push({ kind: 'added', b: n.text, group: g, split: need.length > 0 && need.every((st) => known(have, st)) }); return; }
      best.used = true; items.push({ kind: classifyEdit(best.text, n.text), a: best.text, b: n.text, group: g });
    });
    const newTexts = news.map((n) => n.text);
    olds.filter((o) => !o.used).forEach((o) => items.push({ kind: 'dropped', a: o.text, group: g, repeat: covered(o.text, newTexts) }));
  });
  return items;
}

function assessChange(before, after) {
  const res = { reworded: 0, minor: 0, cosmetic: 0, unchanged: 0, dropped: 0 };
  changeItems(before, after).forEach((it) => { res[{ rewrite: 'reworded', added: 'reworded', minor: 'minor', cosmetic: 'cosmetic', unchanged: 'unchanged', dropped: 'dropped' }[it.kind]]++; });
  return res;
}

// ── the accepted result: guard, withhold, sanitise ──────────────────────────────────────────────────────────────────
// reconcile() FLAGS unsupported lines. guardResume() goes one step further and returns only what is accepted: every flagged line is put
// back to the customer's own wording (it is "withheld"), the result is re-checked until nothing is flagged, and only known resume fields
// survive (so an unexpected key or a non-text value from the AI never reaches the page, a PDF or a Word file).
// What was withheld is reported WITHOUT the AI's text, only where it was and why, so a withheld suggestion is never handed out for free.
const SECTIONS_ = ['experience', 'volunteer', 'projects'];
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

// Putting ONE flagged line back. The AI often changes how many lines there are (it splits a run-on into separate bullets, merges repeats), so
// "line 4" no longer means the customer's line 4. The flagged line is swapped for the customer's own line it came from (the one it shares the
// most words with); with nothing in common it is dropped. The other lines of the entry are kept: one questionable word must not throw away a
// whole entry's improvements. Tailor re-orders on purpose, so there the whole group is put back.
// A line is withheld whole because ONE of its words is a reach ("perform", "repair"). But the same line may also have put the customer's own
// misspellings or word forms right ("cylce" -> "cycle", "damged" -> "damaged"), and that part is theirs and safe. salvage() keeps the customer's line
// exactly as written and applies only those corrections, so withholding a reach never costs the fixes.
// A withheld line therefore stays exactly the customer's wording, apart from words they misspelled or put in the wrong form.
function salvage(origLine, aiLine) {
  const o = s(origLine); const ai = s(aiLine); if (!o.trim() || !ai.trim()) return o;
  // only when the AI's line is plainly this line reworded: most of its content words are the customer's (a misspelling counts as the same word)
  const needs = contentStems(o); const aiW = wordsOf(ai);
  const same = needs.filter((st) => aiW.some((w) => stem(w) === st || nearSpelling(w, st) || nearSpelling(stem(w), st))).length;
  if (needs.length && same < Math.ceil(needs.length / 2)) return o;
  const WORD = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
  const aiWords = (ai.match(WORD) || []).map((w) => w.toLowerCase());
  const own = new Set((o.match(WORD) || []).map((w) => w.toLowerCase()));
  const used = new Set(); let n = 0; let first = '';
  return o.replace(WORD, (w) => {
    const at = n++; const lw = w.toLowerCase(); if (at === 0) first = lw;
    if (lw.length < 4 || aiWords.includes(lw)) return w;                           // the AI kept this word, or it is too short to judge
    // an ordinary word of resumes is not a misspelling ("stocked" is not a typo of "stacked"), so only an unfamiliar word may be corrected
    const ordinary = known(PLAIN_VERBS, stem(lw)) || known(NEUTRAL_STEMS, stem(lw)) || STOP.has(lw);
    // the leading verb may change form ("carry boxes" -> "Carried boxes", "i load" -> "Loaded"); no other word is changed for its form alone ("cans" is not "canned")
    const lead = at === 0 || (at === 1 && /^(i|we|they|he|she)$/.test(first));
    const v = aiWords.find((x, k) => !used.has(k) && !own.has(x) && x !== lw && !claimsWordNotIn(x, o)
      && ((!ordinary && stem(lw) !== stem(x) && (nearSpelling(lw, x) || nearSpelling(x, lw))) || (lead && stem(lw) === stem(x) && !/^(?:led|built|ran)$/.test(x))));   // "nights" is not a typo of "night"
    if (!v) return w;
    used.add(aiWords.indexOf(v));
    return /^[A-Z]/.test(w) ? v.charAt(0).toUpperCase() + v.slice(1) : v;
  });                                                                              // only the corrected words change; capitals and punctuation stay the customer's own
}
// Would this word be a claim (leadership, credential, praise, attendance) that the customer's own line does not make?
function claimsWordNotIn(word, line) {
  return CLAIM_WORDS.some(({ re, rootLen }) => { re.lastIndex = 0; const m = word.match(re); if (!m) return false; return !new RegExp(`\\b${rootOf(m[0], rootLen || 4)}`, 'i').test(line); });
}
const hasDuplicates = (list) => { const seen = new Set(); return arr(list).some((x) => { const k = lineKey(x); if (!k) return false; if (seen.has(k)) return true; seen.add(k); return false; }); };
function revertGroup(current, original, index, groupOnly) {
  const ob = arr(original);
  if (groupOnly) return JSON.parse(JSON.stringify(ob));
  const cur = arr(current).slice();
  if (cur.length === ob.length) {
    const trial = cur.slice(); trial[index] = salvage(ob[index], cur[index]);
    if (!hasDuplicates(trial)) return trial;
  }
  const bad = s(cur[index]); let best = -1; let bestShared = 0;
  ob.forEach((o, k) => { const sh = shared(o, bad); if (sh > bestShared) { best = k; bestShared = sh; } });
  cur[index] = best < 0 ? '' : salvage(ob[best], bad);                     // '' keeps the other indexes stable; empties are removed by tidyGroups
  return cur;
}
// After all flagged lines are put back: remove the placeholders and any line that now appears twice.
function tidyList(list) {
  const seen = new Set(); const same = new Set();
  return arr(list).filter((x) => {
    const k = lineKey(x); if (!k) return false; if (seen.has(k)) return false; seen.add(k);
    const w = [...new Set(contentStems(x))].sort().join(' '); if (w && same.has(w)) return false; if (w) same.add(w);     // "Ring up customers" and "Ring up customer" are one line
    return true;
  });
}

function withholdFlagged(orig, resume, unverified, options = {}) {
  const out = JSON.parse(JSON.stringify(resume));
  const withheld = [];
  const origSummary = isObj(orig.summary) ? orig.summary : {};
  if (!isObj(out.summary)) out.summary = { tagline: '', bullets: [], skills: [] };
  unverified.forEach((u) => {
    const w = s(u.where);
    let m;
    if (w === 'summary.tagline') out.summary.tagline = options.groupOnly ? s(origSummary.tagline) : salvage(s(origSummary.tagline), s(out.summary.tagline));
    else if ((m = /^summary\.bullets\.(\d+)$/.exec(w))) {
      out.summary.bullets = revertGroup(out.summary.bullets, origSummary.bullets, Number(m[1]), options.groupOnly);
    } else if (/^summary\.skills\.\d+$/.test(w)) {
      const keep = arr(out.summary.skills).filter((sk) => s(sk).trim() !== s(u.text).trim());
      const have = new Set(keep.map((x) => lineKey(x)));
      // never lose a skill the customer listed, but do not put back one that an accepted skill already says in corrected form ("costumer service"
      // beside "Customer service")
      arr(origSummary.skills).forEach((sk) => { if (!have.has(lineKey(sk)) && !covered(s(sk), keep.map(s))) keep.push(sk); });
      out.summary.skills = tidyList(keep);
    } else if ((m = /^(experience|volunteer|projects)\.(\d+)\.bullets\.(\d+)$/.exec(w))) {
      const e = arr(out[m[1]])[Number(m[2])]; const o0 = arr(orig[m[1]])[Number(m[2])];
      if (isObj(e) && isObj(o0)) e.bullets = revertGroup(e.bullets, o0.bullets, Number(m[3]), options.groupOnly);
    } else if ((m = /^(experience|volunteer|projects)\.(\d+)\.(summary|description)$/.exec(w))) {
      const e = arr(out[m[1]])[Number(m[2])]; const o0 = arr(orig[m[1]])[Number(m[2])];
      if (isObj(e)) e[m[3]] = isObj(o0) ? (options.groupOnly ? s(o0[m[3]]) : salvage(s(o0[m[3]]), s(e[m[3]]))) : '';
    }
    withheld.push({ where: w, label: describeWhere(orig, w), kind: u.kind, reasons: arr(u.reasons).map(s) });
  });
  if (!options.groupOnly && withheld.length) {
    out.summary.bullets = tidyList(out.summary.bullets);
    SECTIONS_.forEach((k) => arr(out[k]).forEach((e) => { if (isObj(e) && Array.isArray(e.bullets)) e.bullets = tidyList(e.bullets); }));
  }
  return { resume: out, withheld };
}

// The AI may merge repeats and drop duplicates, but it may not delete something the customer actually did. An original line whose words are not
// (mostly) found anywhere in the entry's new lines is put back. Words are compared by stem, so a merged, re-tensed or re-spelled line counts as kept.
const TRIVIAL_STEMS = new Set(['work', 'do', 'help', 'stuff', 'thing', 'various', 'get']);   // vague or empty words: replacing them with a plain noun is not losing a duty
function contentStems(line) { return wordsOf(line).filter((w) => !STOP.has(w)).map(stem).filter((x) => !TRIVIAL_STEMS.has(x)); }
function covered(origLine, newLines) {
  const need = contentStems(origLine); if (!need.length) return true;
  const have = new Set(newLines.flatMap(contentStems)); const haveWords = newLines.flatMap(wordsOf);
  const hit = need.filter((st) => known(have, st) || haveWords.some((w) => nearSpelling(w, st)) || SAME_COVER(st, have)).length;
  // The words of the line are found across the new lines (a run-on split into several bullets, two repeats merged into one) ...
  if (need.length <= 2 ? hit === need.length : hit / need.length >= 0.75) return true;      // "cleaned tables" is not covered by "served the food to the tables": a unique duty stays
  // ... or ONE new line is plainly this line reworded ("Did the register" -> "Operated the register", "Assisted customers at the register" -> "Handled customers at the register").
  return newLines.some((nl) => {
    const ns = new Set(contentStems(nl)); if (!ns.size) return false;
    const h = need.filter((st) => known(ns, st) || SAME_COVER(st, ns) || wordsOf(nl).some((w) => nearSpelling(w, st))).length;
    return h >= 1 && need.length - h <= 1 && ns.size - h <= 1;                    // one word for one word: only the verb differs
  });
}
const SAME_COVER = (st, have) => (SAME_AS[st] || []).some((x) => known(have, stem(x)));
function restoreDropped(orig, current) {
  const fix = (origList, getList, setList) => {
    const now = arr(getList()).map(s).filter((x) => x.trim()); const back = [];
    arr(origList).forEach((o, k) => { if (s(o).trim() && !covered(s(o), now)) back.push([k, s(o)]); });
    if (!back.length) return;
    const next = now.slice(); back.forEach(([k, line]) => next.splice(Math.min(k, next.length), 0, line)); setList(next);
  };
  const os = isObj(orig.summary) ? orig.summary : {};
  if (isObj(current.summary)) fix(os.bullets, () => current.summary.bullets, (v) => { current.summary.bullets = v; });
  SECTIONS_.forEach((k) => arr(orig[k]).forEach((o, i) => { const e = arr(current[k])[i]; if (isObj(o) && isObj(e)) fix(o.bullets, () => e.bullets, (v) => { e.bullets = v; }); }));
}

// A resume reads as one person's when every line starts with a capital and the pronoun is "I". Lines the AI rewrote usually do; lines kept in the customer's
// own wording (because the AI's version was withheld) often do not, so the result would look half-finished. This is formatting only (worth 0 points), applies to
// the accepted text of AI Polish, and never touches names, titles, employers or schools. A word with a capital inside ("iPhone", "eBay") is left alone.
function capFirst(line) {
  let x = s(line); if (!x.trim()) return x;
  x = x.replace(/(^|[^.\w'’-])i(?=[\s,;:!?]|$)(?!\.)/g, '$1I');                       // the pronoun: "i trained" -> "I trained" ("i.e." is left alone)
  return x.replace(/^(\s*)([a-z][a-z'’-]*)(?![A-Za-z0-9])/, (m, sp, w) => sp + w.charAt(0).toUpperCase() + w.slice(1));
}
function tidyCase(r) {
  const fix = (o, k) => { if (typeof o[k] === 'string') o[k] = capFirst(o[k]); };
  const fixList = (o, k) => { if (Array.isArray(o[k])) o[k] = o[k].map((x) => (typeof x === 'string' ? capFirst(x) : x)); };
  if (isObj(r.summary)) { fix(r.summary, 'tagline'); fixList(r.summary, 'bullets'); fixList(r.summary, 'skills'); }
  SECTIONS_.forEach((k) => arr(r[k]).forEach((e) => { if (isObj(e)) { fix(e, 'summary'); fix(e, 'description'); fixList(e, 'bullets'); } }));
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
  if (options.mode === 'polish') restoreDropped(orig, current);
  if (options.mode === 'polish') tidyCase(current);
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

module.exports = { changeItems, classifyEdit, wordDiff, diffHunks, lineKey, STOP, stem, nearSpelling, known, covered, contentStems, reconcile, reasonsFor, analyse, newContentWords, stemSet, numbersIn, assessChange, scopedReasons, guardResume, withholdFlagged, groundAnalyzed };
