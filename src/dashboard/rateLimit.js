// src/dashboard/rateLimit.js
// Dependency-free sliding-window rate limiter for the dashboard API.
// In-memory (resets on restart) — right-sized for this deployment; swap for
// a store-backed limiter if the app ever runs multiple instances.

const buckets = new Map(); // key -> { count, windowStart }

setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (now - b.windowStart > 5 * 60 * 1000) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

/**
 * @param {Object} opts
 * @param {number} opts.windowMs - window length
 * @param {number} opts.max - max requests per window per IP
 * @param {string} opts.name - bucket namespace
 */
function rateLimit({ windowMs, max, name }) {
  return (req, res, next) => {
    // Behind nginx/cloudflared the client IP is in X-Forwarded-For;
    // fall back to the socket address locally.
    const fwd = req.headers['x-forwarded-for'];
    const ip = (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') ||
      req.socket.remoteAddress || 'unknown';
    const key = `${name}:${ip}`;
    const now = Date.now();

    let b = buckets.get(key);
    if (!b || now - b.windowStart >= windowMs) {
      b = { count: 0, windowStart: now };
      buckets.set(key, b);
    }
    b.count++;

    if (b.count > max) {
      const retryAfter = Math.ceil((b.windowStart + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }
    next();
  };
}

module.exports = { rateLimit };
