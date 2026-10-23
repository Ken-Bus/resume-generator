// "One paid operation at a time per code": the decision, with scripted database answers for the awkward interleavings.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isFirstInFlight } = require('../../netlify/functions/_lib/inflight');

// A fake client whose successive reads of license_reservations return the scripted lists.
const client = (...reads) => { let i = 0; const q = { eq: () => q, gt: () => q, order: () => q, limit: () => Promise.resolve({ data: reads[Math.min(i++, reads.length - 1)], error: null }), select: () => q }; return { from: () => q }; };
const A = { id: 'a', created_at: '2026-10-23T10:00:00.000Z' }; const B = { id: 'b', created_at: '2026-10-23T10:00:00.050Z' };

test('alone: go', async () => { assert.equal(await isFirstInFlight(client([A]), 'FG-X', 'a', undefined, 0), true); assert.equal(await isFirstInFlight(client([]), 'FG-X', 'a', undefined, 0), true); });
test('someone is ahead of me: yield at once', async () => { assert.equal(await isFirstInFlight(client([A, B]), 'FG-X', 'b', undefined, 0), false); });
test('double-click: the earlier one waits, the later one yielded, so the earlier proceeds', async () => { assert.equal(await isFirstInFlight(client([A, B], [A]), 'FG-X', 'a', undefined, 0), true); });
test('THE RACE: the later-inserted but earlier-stamped request sees one that is already running; it must NOT also proceed', async () => {
  // B checked first and saw only itself (so it runs). A (stamped earlier, inserted later) sees [A, B], waits, and B is still there.
  assert.equal(await isFirstInFlight(client([B]), 'FG-X', 'b', undefined, 0), true);
  assert.equal(await isFirstInFlight(client([A, B], [A, B]), 'FG-X', 'a', undefined, 0), false);
});
test('a failing read is an error, not a yes', async () => {
  const bad = { from: () => { const q = { eq: () => q, gt: () => q, order: () => q, select: () => q, limit: () => Promise.resolve({ data: null, error: new Error('db down') }) }; return q; } };
  await assert.rejects(() => isFirstInFlight(bad, 'FG-X', 'a', undefined, 0), /db down/);
});
