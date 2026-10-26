// Collective-improvement scoring: the owner-approved, deterministic rule that decides whether an AI Polish is worth one generation.
// (Owner decision 2026-10-23. No AI judgement is involved anywhere in it: the same accepted edits always score the same.)
//
// It scores only what was ACCEPTED (the integrity guard has already put every unsupported line back to the customer's own wording, so
// rejected material can never earn a point), by comparing the customer's answers with the accepted result:
//
//   Accepted change                                                              Points
//   substantial, factually supported rewrite (new wording the old line lacked)     3
//   genuine spelling, grammar or tense correction (one word put right)             1   each
//   removal of genuine repetition (a line whose words are all still there)         1   each
//   a vague word made specific ("did the register" -> "operated the register")     1   each
//   a restructured line that adds no new word, or one piece of a split line        1   each
//   capitals, punctuation, spacing, a re-ordered list, a synonym swap,
//   one added word, filler, anything unsupported                                   0
//
// Total >= THRESHOLD (3): the improvements are applied and exactly ONE generation is charged.
// Total <  THRESHOLD    : the customer's wording is kept, the reservation is released, nothing is charged.
// The same underlying fix is never counted twice: "custmers" -> "customers" fixed on five lines is one correction, and a correction inside a
// line that was rewritten or restructured is part of that rewrite, not an extra point.
// Pure functions: unit-tested without a database or the AI provider.
const I = require('./integrity');

const THRESHOLD = 3;
const VAGUE = new Set(['did', 'do', 'got', 'stuff', 'things', 'thing', 'various']);

const sameWord = (x, y) => x !== y && (I.stem(x) === I.stem(y) || I.nearSpelling(x, y) || I.nearSpelling(y, x));
const allStop = (words) => words.every((w) => I.STOP.has(w));

// One edited line (old text a, new text b). Returns [[kind, points], ...]; `seen` makes a repeated identical fix count once.
function scorePair(a, b, seen) {
  const { hunks, a: A } = I.diffHunks(a, b);
  const items = []; let substantive = false;
  const once = (key) => { if (seen.has(key)) return false; seen.add(key); return true; };
  const fixes = [];                                                        // corrections and the like found in this line
  for (const h of hunks) {
    if (h.del.length && h.del.length === h.ins.length && h.del.every((x, k) => sameWord(x, h.ins[k]))) {       // every word put right
      h.del.forEach((x, k) => fixes.push(['correction', `c:${x}>${h.ins[k]}`]));
    } else if (!h.ins.length) {                                            // words taken out
      const repeat = h.del.length === 1 && (A[h.at - 1] === h.del[0] || A[h.at + 1] === h.del[0]);              // "also also", "the the"
      if (repeat) fixes.push(['repeat', `r:${h.del[0]}`]);
      else if (h.del.length > 1 && !allStop(h.del)) substantive = true;   // several words cut out: the line was reshaped. One word, or filler, is worth nothing
    } else if (!h.del.length) {                                            // words put in
      if (!allStop(h.ins) && h.ins.length > 1) substantive = true;         // one added word, or only filler, is worth nothing
    } else if (h.del.length === 1 && h.ins.length === 1) {                 // one word swapped for another
      if (VAGUE.has(h.del[0])) fixes.push(['specific', `v:${h.del[0]}>${h.ins[0]}`]);                           // a synonym swap is worth nothing
    } else substantive = true;                                             // several words replaced or moved
  }
  if (substantive) {
    const old = new Set(I.contentStems(a));
    const fresh = I.contentStems(b).filter((st) => !I.known(old, st) && !A.some((o) => I.nearSpelling(st, I.stem(o))));
    if (fresh.length) return [['rewrite', 3]];                             // the line now says something the old one did not
    const own = fixes.filter(([, key]) => once(key));
    return [['restructure', Math.max(1, own.length)]];                     // same words, better shape (any corrections inside are part of it)
  }
  fixes.forEach(([kind, key]) => { if (once(key)) items.push([kind, 1]); });
  return items;
}

// before / after: resume objects (the customer's answers and the ACCEPTED polish). -> { points, charge, threshold, by }
// `aiAnswer` (optional): the AI's raw answer. A removed repeat is credited only when the AI itself left that line out, so tidying done by the guard
// (restoring or de-duplicating lines around a withheld suggestion) can never earn a charge for work the AI did not do.
function score(before, after, aiAnswer) {
  const aiKeys = aiAnswer ? new Set(I.changeItems(aiAnswer, aiAnswer).map((it) => I.lineKey(it.b || it.a))) : null;
  const seen = new Set(); const by = { rewrite: 0, restructure: 0, correction: 0, specific: 0, repeat: 0, split: 0, added: 0 };
  let points = 0;
  const add = (kind, n) => { by[kind] += 1; points += n; };
  I.changeItems(before, after).forEach((it) => {
    if (it.kind === 'added') { if (it.split) add('split', 1); else add('added', 3); return; }
    if (it.kind === 'dropped') { if (it.repeat && !(aiKeys && aiKeys.has(I.lineKey(it.a)))) add('repeat', 1); return; }                  // each repeated line taken out is one repetition removed
    if (it.kind === 'unchanged' || it.kind === 'cosmetic') return;
    scorePair(it.a, it.b, seen).forEach(([kind, n]) => add(kind, n));
  });
  return { points, charge: points >= THRESHOLD, threshold: THRESHOLD, by };
}

module.exports = { score, scorePair, THRESHOLD };
