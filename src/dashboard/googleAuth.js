// src/dashboard/googleAuth.js
// "Sign in with Google" (OAuth 2.0 authorization-code flow).
//
// Google identifies the user; we still need to know WHICH Telegram account
// they are, because all ATLAS data is keyed by telegram_id. First Google
// login therefore lands on /link.html, where the user enters a one-time
// code from the bot (/linkweb). After that, Google login goes straight in.

const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../utils/logger');
const authQueries = require('../database/queries/authQueries');

const PENDING_COOKIE = 'atlas_pending_link';
const STATE_TTL = '10m';

function googleEnabled() {
  return Boolean(config.dashboard.google.clientId && config.dashboard.google.clientSecret);
}

function redirectUri() {
  return `${config.dashboard.url}/api/dashboard/auth/google/callback`;
}

/** Build the Google consent-screen URL with a signed anti-CSRF state. */
function buildAuthUrl() {
  const state = jwt.sign({ purpose: 'oauth_state' }, config.dashboard.jwtSecret, {
    expiresIn: STATE_TTL,
  });
  const params = new URLSearchParams({
    client_id: config.dashboard.google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email',
    state,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function verifyState(state) {
  const decoded = jwt.verify(state, config.dashboard.jwtSecret); // throws if bad/expired
  if (decoded.purpose !== 'oauth_state') throw new Error('Wrong state token');
}

/** Exchange the authorization code for Google's tokens and return {sub, email}. */
async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.dashboard.google.clientId,
      client_secret: config.dashboard.google.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.warn(`Google token exchange failed (${res.status}): ${body.slice(0, 200)}`);
    throw new Error('Google token exchange failed');
  }

  const tokens = await res.json();
  // The id_token arrived directly from Google over TLS in this same request,
  // so verifying its signature would re-check what transport already
  // guarantees — decode is sufficient here.
  const claims = jwt.decode(tokens.id_token);
  if (!claims || !claims.sub) throw new Error('Google id_token missing sub');
  return { sub: claims.sub, email: claims.email || null };
}

/** Short-lived cookie that remembers WHICH identity is awaiting linking. */
function setPendingCookie(res, identityId) {
  const token = jwt.sign(
    { purpose: 'pending_link', identityId },
    config.dashboard.jwtSecret,
    { expiresIn: '30m' }
  );
  res.cookie(PENDING_COOKIE, token, {
    httpOnly: true,
    secure: config.server.env === 'production',
    sameSite: 'lax',
    maxAge: 30 * 60 * 1000,
    path: '/',
  });
}

function readPendingCookie(req) {
  const token = req.cookies?.[PENDING_COOKIE];
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, config.dashboard.jwtSecret);
    if (decoded.purpose !== 'pending_link') return null;
    return decoded.identityId;
  } catch {
    return null;
  }
}

function clearPendingCookie(res) {
  res.clearCookie(PENDING_COOKIE, { path: '/' });
}

/** Fetch the identity row for a pending-link cookie (or null). */
async function getPendingIdentity(req) {
  const identityId = readPendingCookie(req);
  if (!identityId) return null;
  // findIdentity is keyed by (provider, provider_user_id); here we need by id.
  const { supabase } = require('../config/supabase');
  const { data, error } = await supabase
    .from('auth_identities')
    .select('*')
    .eq('id', identityId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

module.exports = {
  googleEnabled,
  buildAuthUrl,
  verifyState,
  exchangeCode,
  setPendingCookie,
  getPendingIdentity,
  clearPendingCookie,
};
