// SPEC of the PROPOSED collective charging rule (docs/PROPOSAL_COLLECTIVE_CHARGING.md). NOT used by any handler: polish-resume still charges
// by `assessChange().reworded > 0`. This file exists so the owner can see, with executable examples, exactly what the proposal would do.
const I = require('../../netlify/functions/_lib/integrity');
const key = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// How many points is one accepted change worth?
//   rewrite      3   new wording with at least one content word the old line did not have
//   rearranged   1   same words, different shape (a re-ordered sentence, a condensed line, one piece of a split run-on)
//   clarified    1   ONE vague word (did, do, got, stuff, things, thing, various) replaced by a specific one ("Did the register" -> "Operated the register")
//   correction   1   ONE word changed to its corrected form: spelling ("closing"), grammar/tense ("handle" -> "handled"), or an immediate repeat removed
//   added line   3   a new line that brings a new content word;  1 when every content word comes from an existing line (a split)
//   repeat gone  1   a line that only repeated another line was removed (its words are still in the result)
//   0 points     capitals/punctuation/spacing, re-ordering a list, a one-word synonym ("Helped" -> "Assisted"), one added word ("donated"), filler,
//                deleting something not repeated (the guard puts those back anyway)
// A polish is charged when the points add up to THRESHOLD or more: one real rewrite, or three corrections.
const THRESHOLD = 3;

const VAGUE = new Set(['did', 'do', 'got', 'stuff', 'things', 'thing', 'various']);
function correctionKind(a, b) {
  const d = I.wordDiff(a, b);
  if (d.del.length === 1 && d.ins.length === 1) { const [x] = d.del; const [y] = d.ins; return I.stem(x) === I.stem(y) || I.nearSpelling(x, y) || I.nearSpelling(y, x) ? 'correction' : VAGUE.has(x) ? 'correction' : 'substitution'; }
  if (d.del.length === 1 && d.ins.length === 0) return key(b).split(' ').includes(d.del[0]) ? 'correction' : 'removal';
  return d.ins.length === 1 ? 'addition' : 'filler';
}
function points(before, after) {
  const by = { rewrite: 0, rearranged: 0, correction: 0, split: 0, added: 0, repeatGone: 0, zero: 0 }; let total = 0;
  const add = (k, n) => { by[k]++; total += n; };
  I.changeItems(before, after).forEach((it) => {
    if (it.kind === 'rewrite') {
      const old = new Set(I.contentStems(it.a)); const fresh = I.contentStems(it.b).filter((st) => !I.known(old, st));
      if (fresh.length) add('rewrite', 3); else add('rearranged', 1);
    } else if (it.kind === 'added') it.split ? add('split', 1) : add('added', 3);
    else if (it.kind === 'minor') correctionKind(it.a, it.b) === 'correction' ? add('correction', 1) : add('zero', 0);
    else if (it.kind === 'dropped') it.repeat ? add('repeatGone', 1) : add('zero', 0);
  });
  return { total, charge: total >= THRESHOLD, by };
}
module.exports = { points, THRESHOLD, correctionKind };
