// src/utils/adminAlert.js
// DMs fatal errors to the admin's own Telegram chat, so the operator learns
// the bot is broken before users do. Throttled so an error loop can't flood
// Telegram (and get the bot rate-limited on top of the original problem).

const config = require('../config');
const logger = require('./logger');

const THROTTLE_MS = 5 * 60 * 1000; // max one alert per error-type per 5 min
const lastSent = new Map(); // key -> timestamp

// Strip values that look like API keys, tokens, or secrets from error text.
const SECRET_PATTERN = /(?:key|token|secret|password|authorization|bearer)[\s:=]*['\"]?[A-Za-z0-9_\-./+=]{16,}['\"]?/gi;
function sanitize(text) {
  return String(text).slice(0, 1000).replace(SECRET_PATTERN, '[REDACTED]');
}

let botRef = null;

function setBot(bot) {
  botRef = bot;
}

/**
 * Send an alert DM to the admin. Fire-and-forget — alerting must never
 * throw into the code path that was already failing.
 * @param {string} key - throttle bucket, e.g. 'uncaught', 'polling', 'express'
 * @param {string} message - short human-readable description
 */
function alertAdmin(key, message) {
  try {
    const adminId = config.telegram.adminId;
    if (!adminId || !botRef) return;

    const now = Date.now();
    if (now - (lastSent.get(key) || 0) < THROTTLE_MS) return;
    lastSent.set(key, now);

    const text =
      `🚨 ATLAS error [${key}]\n\n` +
      `${sanitize(message)}\n\n` +
      `${new Date().toISOString()}`;

    botRef.sendMessage(adminId, text).catch((err) => {
      logger.error('Admin alert failed to send:', err.message);
    });
  } catch (err) {
    logger.error('Admin alert error:', err.message);
  }
}

module.exports = { setBot, alertAdmin };
