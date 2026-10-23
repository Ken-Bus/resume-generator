// Licensed PDF/Word export: authorization is checked by the server, against the database, on every request.
// Direct function requests (no browser) must be refused without a valid license, whatever the client claims.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { H, loadHandlers, post, sleep, parseBody, installAi, captureLogs } = require('./harness');
const { pdfText, pdfImages, pdfPages, docxText } = require('./files');
const Templates = require(path.join('..', '..', 'templates.js'));

let seq = 0;
const newCode = () => `FG-E${String(++seq).padStart(3, '0')}-CCCC`;
const ip = (n) => ({ headers: { 'x-nf-client-connection-ip': `198.51.100.${n}` } });

const RESUME = {
  name: 'Emma Larsen', contact: { phone: '(312) 555-0187', email: 'emma.larsen@example.com', location: 'Chicago, IL', linkedin: '', website: '' },
  summary: { tagline: 'Retail operations leader', bullets: ['Led store teams across the Midwest'], skills: ['Merchandising', 'Vendor Relations'] },
  experience: [{ title: 'Operations Manager', company: 'Fictional Retail Co', location: 'Chicago, IL', start: 'March 2020', end: 'Present', summary: 'Oversaw operations for 18 stores.', bullets: ['Reduced shrinkage through audits', 'Trained new store leads'] }],
  education: [{ degree: 'B.S., Merchandising', school: 'Fictional Institute', location: '', date: '2008', honors: 'Magna Cum Laude' }],
  certifications: [{ name: 'Retail Analytics', org: 'Fictional Council', date: '2022' }],
  projects: [{ name: 'Loyalty launch', description: 'Launched a customer loyalty program', bullets: ['Built the enrollment process'] }],
  volunteer: [{ title: 'Volunteer', organization: 'Community Pantry', location: '', start: '2021', end: 'Present', bullets: ['Packed grocery boxes'] }], awards: ['Regional Leader Award']
};

test('export-resume: server-enforced authorization (real SQL, no AI)', async (t) => {
  if (!(await H.available())) { t.skip('no local Postgres reachable (see tests/README.md)'); return; }
  const db = await H.freshDatabase('rg_export');
  await db.admin(H.SUPABASE_DEFAULT_PRIVS);
  await H.liveState(db); await H.applyMigration(db, H.MIG1); await H.applyMigration(db, H.MIG2); await H.applyMigration(db, H.MIG3);
  const hs = loadHandlers(db.pool('service_role', 40));
  const ex = hs.exportResume;
  const ai = installAi({});
  Object.assign(process.env, { SUPABASE_URL: 'http://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', ANTHROPIC_API_KEY: 'mock', TAILOR_TOKEN_SECRET: 'test-secret-test-secret-test-secret-0123456789' });

  const seed = async (uses = 5) => { const c = newCode(); await H.seed(db, [{ code: c, uses, assigned: true }]); return c; };
  const uses = async (c) => (await db.admin('select uses_remaining u from licenses where code=$1', [c])).rows[0].u;
  const reservations = async () => Number((await db.admin('select count(*) n from license_reservations')).rows[0].n);
  const call = (body, n = 1) => ex.handler({ httpMethod: 'POST', ...ip(n), body: typeof body === 'string' ? body : JSON.stringify(body) });
  const req = (code, extra = {}) => ({ code, format: 'pdf', template: 'boardroom', alt: false, resume: RESUME, ...extra });
  const reset = () => { ex._limiters.failedLookups.reset(); ex._limiters.perCode.reset(); ai.calls = 0; };
  const bin = (r) => Buffer.from(r.body, 'base64');

  await t.test('no license, malformed, unknown or empty code: refused with no file, whatever the client claims', async () => {
    reset();
    const refused = [
      [req(undefined), 401], [req(''), 401], [req(null), 401], [req(12345), 401], [req('nope'), 400], [req('FG-AAAA'), 400],
      [req('FG-ZZZZ-9999'), 403], [req("FG-ZZZZ-99' OR '1'='1"), 400],
      // a tampered page: client-side flags and counters mean nothing to the server
      [{ ...req('FG-ZZZZ-9999'), verified: true, licensed: true, usesRemaining: 99, unlocked: true }, 403],
      [{ ...req(undefined), verified: true, licensed: true }, 401]
    ];
    for (const [body, status] of refused) {
      const r = await call(body); assert.equal(r.statusCode, status, JSON.stringify(body).slice(0, 90));
      assert.ok(!r.isBase64Encoded, 'no file may be returned'); assert.match(r.headers['Content-Type'], /json/);
    }
    assert.equal(ai.calls, 0);
  });

  await t.test('valid license: a real PDF and a real Word file come back, as attachments', async () => {
    reset(); const c = await seed();
    const pdf = await call(req(c)); assert.equal(pdf.statusCode, 200); assert.equal(pdf.isBase64Encoded, true);
    assert.equal(pdf.headers['Content-Type'], 'application/pdf'); assert.match(pdf.headers['Content-Disposition'], /^attachment; filename="Emma_Larsen_Resume\.pdf"/);
    assert.equal(pdf.headers['Cache-Control'], 'no-store'); assert.equal(bin(pdf).subarray(0, 5).toString(), '%PDF-');
    const docx = await call(req(c, { format: 'docx' })); assert.equal(docx.statusCode, 200);
    assert.match(docx.headers['Content-Type'], /wordprocessingml\.document$/); assert.equal(bin(docx).subarray(0, 2).toString(), 'PK');
  });

  await t.test('downloading is an authorization check, NOT a generation: balance and reservations never change, even over many downloads', async () => {
    reset(); const c = await seed(); const before = await reservations();
    for (let i = 0; i < 12; i++) assert.equal((await call(req(c, { format: i % 2 ? 'pdf' : 'docx' }))).statusCode, 200);
    assert.equal(await uses(c), 5); assert.equal(await reservations(), before); assert.equal(ai.calls, 0);
  });

  await t.test('a code that has used all five generations can still download (the code is the purchase); the AI stays closed to it', async () => {
    reset(); const c = await seed(0);
    assert.equal((await call(req(c))).statusCode, 200); assert.equal(await uses(c), 0);
    assert.equal(parseBody(await hs.polish(post({ code: c, resume: RESUME }))).usesRemaining, 0);
    assert.equal(ai.calls, 0);
  });

  await t.test('the code is normalised (case, spaces) but never trusted from the client: a deleted code stops working immediately', async () => {
    reset(); const c = await seed();
    assert.equal((await call(req(`  ${c.toLowerCase()} `))).statusCode, 200);
    await db.admin('delete from licenses where code=$1', [c]);
    assert.equal((await call(req(c))).statusCode, 403);                                                       // revocation takes effect at once
  });

  await t.test('exported PDF and Word text is real, complete and in the right order for all 12 templates (direct requests)', async () => {
    reset(); const c = await seed(); const ids = Templates.TEMPLATES.map((x) => x.id); assert.equal(ids.length, 12);
    for (const id of ids) for (const alt of [false, true]) {
      const pdf = bin(await call(req(c, { template: id, alt })));
      const text = pdfText(pdf);
      assert.equal(pdfImages(pdf), 0, `${id}: no page images`);
      for (const needle of ['Operations Manager', 'Oversaw operations for 18 stores.', 'Trained new store leads', 'Loyalty launch', 'Built the enrollment process', 'Community Pantry', 'Packed grocery boxes', 'Magna Cum Laude', 'Retail Analytics', 'Regional Leader Award', 'emma.larsen@example.com'])
        assert.ok(text.includes(needle), `${id}: PDF should contain "${needle}"`);
      const word = docxText(bin(await call(req(c, { template: id, alt, format: 'docx' }))));
      for (const needle of ['Oversaw operations for 18 stores.', 'Loyalty launch', 'Packed grocery boxes', 'March 2020 – Present']) assert.ok(word.includes(needle), `${id}: Word should contain "${needle}"`);
    }
  });

  await t.test('multi-page resumes keep every line, in order, with no blank pages', async () => {
    reset(); const c = await seed();
    const long = JSON.parse(JSON.stringify(RESUME));
    long.experience = Array.from({ length: 10 }, (_, i) => ({ title: `Role ${i + 1}`, company: `Co ${i + 1}`, location: '', start: `${2000 + i}`, end: `${2001 + i}`, summary: '', bullets: Array.from({ length: 6 }, (_, j) => `Task ${i + 1}.${j + 1} ${'long wrapped description text '.repeat(4)}`) }));
    const pdf = bin(await call(req(c, { resume: long })));
    const text = pdfText(pdf); assert.ok(pdfPages(pdf) >= 3);
    let last = -1; for (let i = 1; i <= 10; i++) for (let j = 1; j <= 6; j++) { const at = text.indexOf(`Task ${i}.${j} `); assert.ok(at > last, `Task ${i}.${j} present and in order`); last = at; }
    const word = docxText(bin(await call(req(c, { resume: long, format: 'docx' })))); assert.ok(word.indexOf('Task 1.1 ') < word.indexOf('Task 10.6 '));
  });

  await t.test('blank and partial resumes: no empty headings, no crash; a fully empty one is refused politely', async () => {
    reset(); const c = await seed();
    assert.equal((await call(req(c, { resume: { name: '', contact: {}, experience: [{ title: '', bullets: [''] }], education: [{}], projects: [{ name: '' }], awards: [''] } }))).statusCode, 400);
    for (const partial of [{ name: 'Only A Name' }, { education: [{ school: 'Only School' }] }, { summary: { skills: ['One skill'] } }, { projects: [{ name: 'P' }] }, { awards: ['A'] }, { volunteer: [{ title: 'V' }] }]) {
      const r = await call(req(c, { resume: partial })); assert.equal(r.statusCode, 200, JSON.stringify(partial));
      const text = pdfText(bin(r)); assert.ok(!/EXPERIENCE|CERTIFICATIONS/.test(text), 'no headings for empty sections');
    }
  });

  await t.test('direct-request hardening: methods, malformed JSON, bad format/template, oversized, wrong types, long resumes', async () => {
    reset(); const c = await seed();
    for (const m of ['GET', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) { const r = await ex.handler({ httpMethod: m, ...ip(3) }); assert.equal(r.statusCode, 405, m); assert.equal(r.headers.Allow, 'POST'); }
    assert.equal((await call('{not json')).statusCode, 400); assert.equal((await call('[1,2]')).statusCode, 400);
    for (const bad of [{ format: 'exe' }, { format: 'PDF' }, { format: ['pdf'] }, { format: '__proto__' }, { template: 'nope' }, { template: '../../etc/passwd' }, { template: 'constructor' }, { resume: null }, { resume: [] }, { resume: 'x' }])
      assert.equal((await call(req(c, bad))).statusCode, 400, JSON.stringify(bad));
    const readsBefore = await reservations();
    assert.equal((await call(req(c, { resume: { ...RESUME, name: 'x'.repeat(300000) } }))).statusCode, 413);
    assert.equal((await call(req(c, { resume: { ...RESUME, summary: { tagline: 'y'.repeat(70000), bullets: [], skills: [] } } }))).statusCode, 413);
    assert.equal(await reservations(), readsBefore);
  });

  await t.test('CORS: no response, success or failure, ever carries an Access-Control-* header (same-origin only)', async () => {
    reset(); const c = await seed();
    const responses = [await call(req(c)), await call(req('FG-ZZZZ-9999')), await call('x'), await ex.handler({ httpMethod: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })];
    for (const r of responses) for (const k of Object.keys(r.headers || {})) assert.ok(!/^access-control/i.test(k), `${r.statusCode}: ${k}`);
  });

  await t.test('file names are safe in headers even for unusual names', async () => {
    reset(); const c = await seed();
    for (const name of ['José Müller', '../../etc/passwd', 'Name"; evil="1', '日本語 名前', 'A\r\nX-Injected: 1']) {
      const r = await call(req(c, { resume: { ...RESUME, name } })); assert.equal(r.statusCode, 200);
      const cd = r.headers['Content-Disposition']; assert.ok(!/[\r\n]/.test(cd) && !cd.includes('..') && !cd.includes('/'), cd); assert.ok(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._-]+$/.test(cd), cd);
    }
  });

  await t.test('characters the PDF font cannot draw are simplified and reported; Word keeps them', async () => {
    reset(); const c = await seed(); const r = { ...RESUME, name: 'Zoë Łukasz 日本' };
    const pdf = await call(req(c, { resume: r })); assert.equal(pdf.headers['X-Export-Notice'], 'simplified');
    assert.ok(docxText(bin(await call(req(c, { resume: r, format: 'docx' })))).includes('日本'));
    assert.equal((await call(req(c))).headers['X-Export-Notice'], undefined);
  });

  await t.test('brute force: bad codes are limited per client (429 + Retry-After), good customers from other clients are unaffected', async () => {
    reset(); const c = await seed(); let last;
    for (let i = 0; i < 20; i++) { last = await call(req(`FG-ZZ${String(i).padStart(2, '0')}-9999`), 7); assert.equal(last.statusCode, 403); }
    last = await call(req('FG-ZZZZ-0000'), 7); assert.equal(last.statusCode, 429); assert.ok(Number(last.headers['Retry-After']) >= 1);
    assert.equal((await call(req(c), 7)).statusCode, 429);                                                    // blocked client stays blocked...
    assert.equal((await call(req(c), 8)).statusCode, 200);                                                    // ...other clients are fine
  });

  await t.test('a leaked code cannot be used to scrape the renderer: per-code limit, other codes unaffected', async () => {
    reset(); const c = await seed(), other = await seed(); let codes = [];
    for (let i = 0; i < 62; i++) codes.push((await call(req(c, { resume: { name: 'Q' } }), 9)).statusCode);
    assert.equal(codes.filter((x) => x === 200).length, 60); assert.ok(codes.slice(60).every((x) => x === 429));
    assert.equal((await call(req(other), 9)).statusCode, 200);
  });

  await t.test('concurrent downloads (browser refresh storms, double-clicks) are all served and never charged', async () => {
    reset(); const c = await seed();
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => call(req(c, { format: i % 2 ? 'pdf' : 'docx' }), 20 + (i % 5))));
    assert.ok(rs.every((r) => r.statusCode === 200)); assert.equal(await uses(c), 5);
  });

  await t.test('database trouble => a generic 503 with nothing leaked; logs never contain the code or the resume text', async () => {
    reset(); const logs = captureLogs();
    try {
      const broken = loadHandlers({ query: async () => { throw new Error('connection refused for FG-LEAK-TEST'); } }).exportResume;
      const r = await broken.handler({ httpMethod: 'POST', ...ip(30), body: JSON.stringify(req('FG-LEAK-TEST')) });
      assert.equal(r.statusCode, 503); assert.match(parseBody(r).error, /ref E101/); assert.ok(!r.body.includes('FG-LEAK-TEST')); assert.ok(!r.body.includes('connection refused'));
      const c = await seed(); await call(req(c, { template: 'nope' })); await call(req('FG-ZZZZ-9999'));
      const all = logs.lines.join('\n'); assert.ok(!all.includes('FG-LEAK-TEST')); assert.ok(!all.includes(c)); assert.ok(!all.includes('Emma Larsen'));
    } finally { logs.restore(); loadHandlers(db.pool('service_role', 10)); }
  });

  await db.drop?.();
});
