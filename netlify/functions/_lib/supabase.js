const { createClient } = require('@supabase/supabase-js');

let client;

function getSupabaseClient() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('Supabase credentials not configured');
    }
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

const CODE_RE = /^FG-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function normalizeCode(raw) {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) },
    body: JSON.stringify(body)
  };
}

module.exports = { getSupabaseClient, CODE_RE, normalizeCode, json };
