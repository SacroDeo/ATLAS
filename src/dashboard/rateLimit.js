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
    // Use Express's resolved req.ip. With `trust proxy` set to a fixed hop
    // count in server.js, this is the real client IP and CANNOT be spoofed
    // by a client-supplied X-Forwarded-For header (Express only honors the
    // trusted hop). Reading the raw header here was bypassable: a client
    // could rotate fake IPs to get a fresh bucket on every request.
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
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
