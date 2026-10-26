// Best-effort sliding-window limiter, kept in memory.
// Serverless instances do not share memory, so this only slows a client that keeps hitting one warm instance.
// It is a speed bump, not a guarantee: a global limit needs a platform rate-limit rule or a database table.
function makeLimiter({ windowMs, max }) {
  const hits = new Map();
  const live = (key, now) => {
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length) hits.set(key, arr); else hits.delete(key);
    return arr;
  };
  return {
    // How many seconds until `key` may try again (0 = allowed now). Does not record a hit.
    wait(key, now = Date.now()) {
      const arr = live(key, now);
      return arr.length >= max ? Math.max(Math.ceil((arr[0] + windowMs - now) / 1000), 1) : 0;
    },
    hit(key, now = Date.now()) {
      const arr = live(key, now); arr.push(now); hits.set(key, arr);
      if (hits.size > 5000) hits.delete(hits.keys().next().value);        // bound memory
    },
    reset() { hits.clear(); }
  };
}

function clientIp(event) {
  const h = (event && event.headers) || {};
  const get = (k) => h[k] || h[k.toLowerCase()];
  return String(get('x-nf-client-connection-ip') || String(get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown').slice(0, 64);
}

module.exports = { makeLimiter, clientIp };
