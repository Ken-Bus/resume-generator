// REPLAY of the live acceptance result that was reported as a release blocker (fictional Taylor Rivera; School Food Drive).
// The customer's project had a BLANK description and three bullets. The page showed:
//   description "Helped collect donated food for families in the community."
//   bullet 1    "... donate canned food for families in the community."      bullet 3 "Helped organize donated food for pickup."
// Root cause found: that is byte-for-byte what the 884640f server returned (flagged lines were KEPT with a yellow warning); the current
// server withholds them. These tests pin the current behaviour at every layer the result passes through, and make a stale deploy visible.
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, loadHandlers, post, parseBody, installAi, captureLogs, realReword } = require('./harness');
const integrity = require('../../netlify/functions/_lib/integrity');
const Core = require('../../resume-core.js');

const clone = (o) => JSON.parse(JSON.stringify(o));
const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const TAYLOR = { name: 'Taylor Rivera', contact: { email: 'taylor.rivera@example.com', location: 'Dayton, OH' }, summary: { tagline: 'Seeking a customer service position', bullets: [], skills: ['Teamwork'] },
  experience: [], education: [{ degree: 'High School Diploma', school: 'Oakwood High School', date: '2026' }], certifications: [],
  projects: [{ name: 'School Food Drive', description: '', bullets: ['Asked classmates to donate canned food.', 'Sorted and counted donated items.', 'Helped organize food for pickup.'] }],
  volunteer: [{ title: 'Volunteer', organization: 'Community Food Pantry', start: '2025', end: 'Present', bullets: ['Packed grocery boxes on Saturdays', 'Greeted families as they arrived'] }], awards: [] };
// What the live model returned, exactly as reported.
const LIVE = (r) => { const o = clone(r); const p = o.projects[0];
  p.description = 'Helped collect donated food for families in the community.';
  p.bullets = ['Asked classmates to donate canned food for families in the community.', 'Sorted and counted donated items.', 'Helped organize donated food for pickup.']; return o; };
const NOT_ALLOWED = /famil|communit/i;

test('the live result, replayed through the guard: description stays blank, bullet 1 is the customer\'s own, bullet 3 is an honest reword', () => {
  const g = integrity.guardResume(Core.clean(TAYLOR), LIVE(TAYLOR), { mode: 'polish', vocabulary: 'customer service' });
  const p = g.resume.projects[0];
  assert.equal(p.description, '');
  assert.deepEqual(p.bullets, ['Asked classmates to donate canned food.', 'Sorted and counted donated items.', 'Helped organize donated food for pickup.']);
  assert.equal(NOT_ALLOWED.test(JSON.stringify(g.resume.projects)), false);
  assert.deepEqual(g.withheld.map((w) => w.where).sort(), ['projects.0.bullets.0', 'projects.0.description']);
  // The older design (flag but keep) is exactly what the reported screen showed: it must never be the path again.
  const old = integrity.reconcile(Core.clean(TAYLOR), LIVE(TAYLOR), { vocabulary: 'customer service', keepBlankedText: true, entryScope: true });
  assert.equal(old.resume.projects[0].description, 'Helped collect donated food for families in the community.', 'reconcile alone keeps flagged text, so only guardResume may feed a result to the customer');
  assert.deepEqual(old.unverified.map((u) => u.where).sort(), ['projects.0.bullets.0', 'projects.0.description']);
});

test('the same live result is withheld however the customer\'s data happens to be structured', () => {
  const variants = {
    'description undefined': (s) => { delete s.projects[0].description; },
    'description null': (s) => { s.projects[0].description = null; },
    'description spaces': (s) => { s.projects[0].description = '   '; },
    'no volunteer entry': (s) => { s.volunteer = []; },
    'another volunteer entry that DOES mention families': (s) => { s.volunteer.unshift({ title: 'Helper', organization: 'Church Kitchen', bullets: ['Served meals to families in the community'] }); },
    'an earlier project': (s) => { s.projects.unshift({ name: 'Robotics Club', description: 'Built a robot', bullets: ['Wired the sensors'] }); },
    'the drive also listed as a job': (s) => { s.experience = [{ title: 'Food Drive Lead', company: 'Oakwood High', bullets: ['Ran a food drive for families in the community'] }]; },
    'a summary line about families': (s) => { s.summary.bullets = ['Care about helping families in the community']; },
    'an empty row before the project (the page keeps blank rows)': (s) => { s.projects.unshift({ name: '', description: '', bullets: [''] }); },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const src = clone(TAYLOR); mutate(src);
    const ai = LIVE(Core.clean(src)); // the model answers the cleaned resume the server sent it
    const g = integrity.guardResume(Core.clean(src), ai, { mode: 'polish', vocabulary: 'customer service helping families in the community' });
    const drive = g.resume.projects.find((p) => /food drive/i.test(p.name));
    assert.ok(drive, name);
    assert.equal(NOT_ALLOWED.test(JSON.stringify(drive)), false, `${name}: ${JSON.stringify(drive)}`);
    assert.equal(drive.description, '', name);
  }
});

test('Tailor applies the same entry-scoped guard to the same invention', () => {
  const g = integrity.guardResume(Core.clean(TAYLOR), LIVE(TAYLOR), { mode: 'tailor', vocabulary: 'customer service' });
  assert.equal(NOT_ALLOWED.test(JSON.stringify(g.resume.projects)), false);
  assert.equal(g.resume.projects[0].description, '');
});

test('the build stamp: page and functions share one guard version, and it is bumped with the rules', () => {
  assert.match(Core.GUARD_VERSION, /^[a-z0-9-]{1,40}$/);
  assert.equal(Core.GUARD_VERSION, 'entry-scope-withhold-6');
});

test('polish-resume against real SQL: the live result is now FREE (only a one-word touch-up survives); a real rewrite beside it is charged once; the invented claim never appears', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_live_replay');
  await db.admin(H.SUPABASE_DEFAULT_PRIVS);
  await H.liveState(db); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2); await H.applyMigration(db, H.MIG3);
  const hs = loadHandlers(db.pool('service_role', 20));
  const ai = installAi({});
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'mock', TAILOR_TOKEN_SECRET: SECRET, AI_TIMEOUT_MS: '1000' });
  const code = 'FG-LIVE-AAAA';
  await H.seed(db, [{ code, uses: 5, assigned: true }]);
  const uses = async () => (await db.admin('select uses_remaining u from licenses where code=$1', [code])).rows[0].u;
  ai.polishPayload = LIVE;
  hs.polishModule._nochange._events.clear();
  const w = captureLogs();
  let b;
  try {
    // The page sends the resume as the customer has it, including the blank description and the empty rows the editor keeps.
    const sent = clone(TAYLOR); sent.projects.push({ name: '', description: '', bullets: [''] });
    const res = await hs.polish(post({ code, resume: sent, target: 'customer service', requestId: 'live-replay-0001' }));
    assert.equal(res.statusCode, 200); b = parseBody(res);
  } finally { w.restore && w.restore(); w.stop && w.stop(); }

  // The reported result had exactly ONE accepted change left after the guard: "food for pickup" -> "donated food for pickup". That is a
  // one-word touch-up, so the whole polish is free (the owner's decision after the live test) and nothing is applied.
  assert.equal(b.noChange, true); assert.equal(b.charged, false); assert.equal(b.reason, 'flagged');
  assert.equal(b.usesRemaining, 5); assert.equal(await uses(), 5, 'nothing is charged for a one-word touch-up');
  assert.equal(b.result, undefined, 'and nothing is applied');
  assert.deepEqual(b.changes, { reworded: 0, minor: 1, cosmetic: 0, unchanged: 6, dropped: 0 });
  assert.deepEqual(b.withheld.map((x) => x.where).sort(), ['projects.0.bullets.0', 'projects.0.description']);
  assert.equal(JSON.stringify(b).includes('families in the community.'), false, 'the withheld text itself is not handed back');
  assert.equal(JSON.stringify(b).includes('collect donated food'), false);
  assert.equal(b.guard.version, Core.GUARD_VERSION); assert.equal(b.guard.withholds, true);

  // The same one-word touch-up on its own: free, reason "minor".
  hs.polishModule._nochange._events.clear();
  ai.polishPayload = (r) => { const o = clone(r); o.projects[0].bullets[2] = 'Helped organize donated food for pickup.'; return o; };
  const solo = parseBody(await hs.polish(post({ code, resume: clone(TAYLOR), target: 'customer service', requestId: 'live-replay-0002' })));
  assert.equal(solo.noChange, true); assert.equal(solo.reason, 'minor'); assert.equal(solo.charged, false); assert.equal(await uses(), 5); assert.match(solo.message, /few small fixes/);

  // …but a real rewrite next to the invented claims IS charged once, and the claims are still gone.
  hs.polishModule._nochange._events.clear();
  ai.polishPayload = (r) => { const o = LIVE(r); o.projects[0].bullets[2] = realReword('Helped organize food for pickup'); return o; };
  const mixed = parseBody(await hs.polish(post({ code, resume: clone(TAYLOR), target: 'customer service', requestId: 'live-replay-0003' })));
  const out = JSON.parse(mixed.result); const p = out.projects[0];
  assert.equal(mixed.charged, true); assert.equal(await uses(), 4);
  assert.equal(p.description, ''); assert.equal(p.bullets[0], 'Asked classmates to donate canned food.'); assert.equal(p.bullets[2], realReword('Helped organize food for pickup'));
  assert.equal(NOT_ALLOWED.test(JSON.stringify(out.projects)), false);
  assert.equal(out.volunteer[0].bullets[1], 'Greeted families as they arrived', 'the volunteer entry that really says it is untouched');
  assert.deepEqual(mixed.unverified, []);

  // The free version check: a request with no code spends nothing and reveals which guard this deploy runs.
  const probe = parseBody(await hs.polish(post({})));
  assert.equal(probe.guard.version, Core.GUARD_VERSION);
  assert.equal(await uses(), 4);
  await db.drop?.();
});
