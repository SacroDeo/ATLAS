// src/dashboard/telegramAuth.js
// Security core for the dashboard.
//
// Telegram's Login Widget hands the browser a payload signed with HMAC-SHA256,
// where the secret key is SHA256(bot_token). We recompute that signature
// server-side and reject anything that doesn't match — this is what prevents a
// user from forging someone else's telegram_id and reading their data.
//
// On success we mint our own short-lived JWT and set it as an httpOnly cookie,
// so the Telegram payload is only ever verified once (at login).

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const AUTH_MAX_AGE_SECONDS = 24 * 60 * 60; // reject Telegram login payloads older than 24h
const SESSION_TTL = '7d';                   // dashboard session length
const COOKIE_NAME = 'atlas_session';

/**
 * Verify a Telegram Login Widget payload.
 * @param {object} payload - the query fields Telegram redirects with
 *   (id, first_name, username, photo_url, auth_date, hash, ...)
 * @returns {object} the trusted user fields (without hash)
 * @throws {Error} if the signature is missing, invalid, or expired
 */
function verifyTelegramLogin(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Missing login payload');
  }

  const { hash, ...fields } = payload;
  if (!hash) throw new Error('Missing auth hash');

  // Build the data-check-string: every field except `hash`, sorted by key,
  // joined as "key=value" with newlines. Must match Telegram exactly.
  const dataCheckString = Object.keys(fields)
    .filter((k) => fields[k] !== undefined && fields[k] !== null)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');

  const secretKey = crypto
    .createHash('sha256')
    .update(config.telegram.token)
    .digest();

  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // Constant-time comparison to avoid timing leaks.
  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(String(hash), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid auth signature');
  }

  // Reject stale logins (replay protection).
  const authDate = Number(fields.auth_date);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!authDate || nowSeconds - authDate > AUTH_MAX_AGE_SECONDS) {
    throw new Error('Login expired — please sign in again');
  }

  return fields;
}

// Pin the algorithm on both sign and verify. Without an explicit allow-list,
// jwt.verify would accept any algorithm named in the token header — the basis
// of algorithm-confusion attacks (e.g. a forged "alg":"none" token, or HS/RS
// confusion). We only ever issue HS256, so we only ever accept HS256.
const JWT_ALG = 'HS256';

/** Mint a signed session token carrying the telegram_id. */
function issueSession(telegramId) {
  return jwt.sign(
    { tid: String(telegramId) },
    config.dashboard.jwtSecret,
    { expiresIn: SESSION_TTL, algorithm: JWT_ALG }
  );
}

/** Set the session cookie on a response. */
function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.server.env === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/**
 * Express middleware: require a valid session.
 * On success attaches req.telegramId; otherwise responds 401.
 */
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const decoded = jwt.verify(token, config.dashboard.jwtSecret, { algorithms: [JWT_ALG] });
    req.telegramId = decoded.tid;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired' });
  }
}

module.exports = {
  verifyTelegramLogin,
  issueSession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  COOKIE_NAME,
};
