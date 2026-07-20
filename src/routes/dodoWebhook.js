// src/routes/dodoWebhook.js
// Dodo Payments webhook — Standard Webhooks spec (https://www.standardwebhooks.com).
// MUST be mounted BEFORE express.json() so we get the raw body for HMAC
// verification: signature = base64(HMAC-SHA256(secret, "{id}.{timestamp}.{body}")).
const express = require('express');
const crypto = require('crypto');
const logger = require('../utils/logger');
const premiumQueries = require('../database/queries/premiumQueries');

const router = express.Router();

// Grant window per successful charge: 30 days + 5-day grace so a slightly
// late renewal webhook doesn't lapse a paying subscriber.
const GRANT_DAYS = 35;

const PAID_EVENTS = new Set([
  'payment.succeeded',
  'subscription.active',
  'subscription.renewed',
]);

function verifySignature(secret, msgId, timestamp, body, signatureHeader) {
  // Secret may be prefixed "whsec_" and is base64-encoded per the spec.
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${msgId}.${timestamp}.${body}`)
    .digest('base64');
  // Header holds space-separated "v1,<sig>" entries; accept any match.
  return String(signatureHeader || '')
    .split(' ')
    .some((part) => {
      const sig = part.startsWith('v1,') ? part.slice(3) : part;
      try {
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      } catch {
        return false; // length mismatch
      }
    });
}

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.DODO_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('Dodo webhook hit but DODO_WEBHOOK_SECRET is not set — rejecting.');
    return res.status(503).send('webhook not configured');
  }

  const body = req.body.toString('utf8');
  const ok = verifySignature(
    secret,
    req.get('webhook-id'),
    req.get('webhook-timestamp'),
    body,
    req.get('webhook-signature')
  );
  if (!ok) {
    logger.warn('Dodo webhook: bad signature — ignoring.');
    return res.status(401).send('bad signature');
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return res.status(400).send('bad json');
  }

  // Always 200 fast on verified events; Dodo retries non-2xx.
  res.status(200).send('ok');

  try {
    const type = event.type || event.event_type;
    if (!PAID_EVENTS.has(type)) return;

    const data = event.data || {};
    const telegramId = data.metadata && data.metadata.telegram_id;
    if (!telegramId) {
      logger.warn(`Dodo ${type}: no telegram_id in metadata — cannot map to user.`);
      return;
    }

    const until = new Date(Date.now() + GRANT_DAYS * 864e5).toISOString();
    await premiumQueries.setTier(Number(telegramId), 'premium', until);
    logger.info(`Dodo ${type}: premium granted to ${telegramId} until ${until}`);

    // Best-effort notifications; bot may not be ready during boot.
    try {
      const { alertAdmin } = require('../utils/adminAlert');
      alertAdmin('dodo', `💳 Dodo payment: premium granted to ${telegramId} (${type})`);
    } catch { /* non-fatal */ }
  } catch (err) {
    logger.error('Dodo webhook processing error:', err.message);
  }
});

module.exports = router;
