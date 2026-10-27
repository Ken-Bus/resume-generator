// Test helper: lets the browser tests talk to the REAL export-resume handler (real PDF/Word rendering, real
// authorization logic). Only the database lookup is replaced: a code is "licensed" if it is in `valid`.
const Module = require('module');
const path = require('path');

const FUNCS = path.join(__dirname, '..', '..', 'netlify', 'functions');
let valid = new Set();
let accessStates = new Map();      // code -> access state ('active' | 'completion' | 'ended'); a code not listed behaves like a database WITHOUT migration 05
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@supabase/supabase-js') {
    return { createClient: () => ({
      from: () => ({ select: () => ({ eq: (col, code) => ({
        maybeSingle: async () => ({ data: valid.has(code) ? { uses_remaining: 5, max_uses: 5 } : null, error: null }) }) }) }),
      rpc: (fn, args) => ({ maybeSingle: async () => (fn === 'license_access_status' && accessStates.has(args.p_code)
        ? { data: { access_state: accessStates.get(args.p_code), uses_remaining: 0, max_uses: 5, included_available: 0 }, error: null }
        : { data: null, error: { code: '42883', message: 'function does not exist' } }) })
    }) };
  }
  return origLoad.call(this, request, ...rest);
};
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://mock.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'mock-not-a-real-key';
const handler = require(path.join(FUNCS, 'export-resume.js'));

// Mock for the page's /.netlify/functions/export-resume route. Returns a raw (binary-capable) response.
function exportApi(codes = ['FG-TEST-AAAA']) {
  valid = new Set(codes);
  handler._limiters.failedLookups.reset(); handler._limiters.perCode.reset();
  return async (body) => {
    const res = await handler.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '203.0.113.9' }, body: JSON.stringify(body) });
    return { raw: true, status: res.statusCode, headers: res.headers || {}, body: res.body, isBase64Encoded: !!res.isBase64Encoded };
  };
}

function setAccessStates(map) { accessStates = new Map(Object.entries(map || {})); }

module.exports = { exportApi, handler, setAccessStates };
