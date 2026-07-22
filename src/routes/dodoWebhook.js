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

    // DEFENSE-IN-DEPTH: only grant Pro for OUR product. The signature already
    // proves the event is genuinely from Dodo, and our checkout binds a fixed
    // DODO_PRODUCT_ID — but if a cheaper product is ever added, a low-value
    // purchase carrying this same metadata must NOT unlock Pro. Bind the grant
    // to the expected product id when Dodo includes it in the payload.
    const expectedProduct = process.env.DODO_PRODUCT_ID;
    const eventProduct =
      data.product_id ||
      (Array.isArray(data.product_cart) && data.product_cart[0] && data.product_cart[0].product_id) ||
      null;
    if (expectedProduct && eventProduct && String(eventProduct) !== String(expectedProduct)) {
      logger.warn(`Dodo ${type}: product ${eventProduct} != expected ${expectedProduct} — NOT granting premium for ${telegramId}.`);
      return;
    }

    // Log the amount for observability (confirms the real field name/value on
    // your first live payment; set DODO_MIN_AMOUNT_CENTS afterward to enforce).
    const amount = data.total_amount ?? data.amount ?? data.settlement_amount ?? null;
    const minAmount = process.env.DODO_MIN_AMOUNT_CENTS
      ? parseInt(process.env.DODO_MIN_AMOUNT_CENTS, 10)
      : null;
    if (minAmount != null && amount != null && Number(amount) < minAmount) {
      logger.warn(`Dodo ${type}: amount ${amount} < min ${minAmount} — NOT granting premium for ${telegramId}.`);
      return;
    }
    logger.info(`Dodo ${type}: amount=${amount} product=${eventProduct ?? 'n/a'} for ${telegramId}`);

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
