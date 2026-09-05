// src/routes/dodoWebhook.js
// Dodo Payments webhook — Standard Webhooks spec (https://www.standardwebhooks.com).
// MUST be mounted BEFORE express.json() so we get the raw body for HMAC
// verification: signature = base64(HMAC-SHA256(secret, "{id}.{timestamp}.{body}")).
const express = require('express');
const crypto = require('crypto');
const logger = require('../utils/logger');
const premiumQueries = require('../database/queries/premiumQueries');
const { supabase } = require('../config/supabase');

const router = express.Router();

// Rate limiting for webhook endpoint (prevents DoS on HMAC verification)
const webhookRateLimits = new Map(); // Map<IP, { count, windowStart }>
const WEBHOOK_MAX_PER_MINUTE = 100;
const WEBHOOK_WINDOW_MS = 60 * 1000;

function checkWebhookRateLimit(ip) {
  const now = Date.now();
  let entry = webhookRateLimits.get(ip);

  if (!entry || now - entry.windowStart >= WEBHOOK_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
  }

  entry.count++;
  webhookRateLimits.set(ip, entry);

  if (entry.count > WEBHOOK_MAX_PER_MINUTE) {
    const retryAfterSeconds = Math.ceil((WEBHOOK_WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true };
}

// Cleanup stale rate limit entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of webhookRateLimits.entries()) {
    if (now - entry.windowStart > WEBHOOK_WINDOW_MS * 2) {
      webhookRateLimits.delete(ip);
    }
  }
}, 2 * 60 * 1000).unref();

// Purge idempotency records older than 7 days every 6 hours
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('processed_webhook_events').delete().lt('processed_at', cutoff);
  } catch (err) {
    logger.error('Webhook idempotency cleanup failed:', err.message);
  }
}, 6 * 60 * 60 * 1000).unref();

// Grant window per successful charge: 30 days + 5-day grace so a slightly
// late renewal webhook doesn't lapse a paying subscriber.
const GRANT_DAYS = 35;

// Webhook timestamp tolerance (5 minutes) - prevents replay attacks
const TIMESTAMP_TOLERANCE_SECONDS = 300;

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
  // Rate limiting check
  const clientIp = req.ip;
  const rateCheck = checkWebhookRateLimit(clientIp);
  if (!rateCheck.allowed) {
    logger.warn(`Webhook rate limit exceeded for IP ${clientIp}`);
    return res.status(429).set('Retry-After', String(rateCheck.retryAfterSeconds)).send('rate limit exceeded');
  }

  const secret = process.env.DODO_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('Dodo webhook hit but DODO_WEBHOOK_SECRET is not set — rejecting.');
    return res.status(503).send('webhook not configured');
  }

  const body = req.body.toString('utf8');
  const msgId = req.get('webhook-id');
  const msgTimestamp = req.get('webhook-timestamp');
  const msgSignature = req.get('webhook-signature');

  // Standard Webhooks requires a webhook-id on every delivery. It anchors both
  // the HMAC (the signed string is "{id}.{timestamp}.{body}") and our
  // idempotency claim, so a request without one is malformed — reject it rather
  // than fall through to a path that skips dedup entirely (BUG-028).
  if (!msgId) {
    logger.warn('Dodo webhook: missing webhook-id header — rejecting.');
    return res.status(400).send('missing webhook-id');
  }

  // Timestamp validation - prevent replay attacks
  const timestampSeconds = parseInt(msgTimestamp, 10);
  if (isNaN(timestampSeconds)) {
    logger.warn('Dodo webhook: missing or invalid timestamp — rejecting.');
    return res.status(400).send('invalid timestamp');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const timeDiff = Math.abs(nowSeconds - timestampSeconds);

  if (timeDiff > TIMESTAMP_TOLERANCE_SECONDS) {
    logger.warn(`Dodo webhook: timestamp too old/future (${timeDiff}s diff) — rejecting replay attempt.`);
    return res.status(401).send('timestamp out of range');
  }

  // Signature verification
  const ok = verifySignature(secret, msgId, msgTimestamp, body, msgSignature);
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

  // ── Classify the event BEFORE claiming ──────────────────────────────────────
  // We must know event_type before the idempotency insert (it's a NOT NULL
  // column), and deterministic "we won't grant" outcomes (non-paid type, wrong
  // product) should 200 without burning a claim row.
  const type = event.type || event.event_type;

  // Non-paid events are valid but carry no grant. Ack so Dodo stops retrying —
  // there is nothing here to make idempotent.
  if (!PAID_EVENTS.has(type)) return res.status(200).send('ignored');

  const data = event.data || {};
  const telegramId = data.metadata && data.metadata.telegram_id;
  if (!telegramId) {
    // A paid event we cannot map to a user. A retry won't add the id, so ack and
    // surface it for manual reconciliation rather than looping forever.
    logger.warn(`Dodo ${type}: no telegram_id in metadata — cannot map to user.`);
    return res.status(200).send('no telegram_id');
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
    return res.status(200).send('ignored: product mismatch');
  }

  // Log the amount for observability (confirms the real field name/value on
  // your first live payment; set DODO_MIN_AMOUNT_CENTS afterward to enforce).
  const amount = data.total_amount ?? data.amount ?? data.settlement_amount ?? null;
  const minAmount = process.env.DODO_MIN_AMOUNT_CENTS
    ? parseInt(process.env.DODO_MIN_AMOUNT_CENTS, 10)
    : null;
  if (minAmount != null && amount != null && Number(amount) < minAmount) {
    logger.warn(`Dodo ${type}: amount ${amount} < min ${minAmount} — NOT granting premium for ${telegramId}.`);
    return res.status(200).send('ignored: below minimum');
  }
  logger.info(`Dodo ${type}: amount=${amount} product=${eventProduct ?? 'n/a'} for ${telegramId}`);

  // ── Idempotency CLAIM (insert-first) ─────────────────────────────────────────
  // The INSERT — not the old code's SELECT — is the atomic mutex: event_id is
  // UNIQUE, so exactly one concurrent delivery of an event wins the insert and
  // the rest get 23505. Claiming BEFORE the grant (the old code inserted AFTER
  // it, and 200'd before either ran) closes the double-process window and makes
  // a mid-grant crash retriable instead of silently swallowed (BUG-028).
  const { error: claimError } = await supabase
    .from('processed_webhook_events')
    .insert({
      event_id: msgId,
      event_type: type,
      telegram_id: Number(telegramId),
      processed_at: new Date().toISOString(),
    });

  if (claimError) {
    if (claimError.code === '23505') {
      // Unique violation → this event id is already claimed/processed.
      logger.info(`Dodo webhook ${msgId}: already processed — idempotent skip.`);
      return res.status(200).send('already processed');
    }
    // Any other DB error: the claim could not be established. Fail closed with a
    // non-2xx so Dodo retries, rather than risk a double or a missed grant.
    logger.error('Webhook idempotency claim failed:', claimError.message);
    return res.status(503).send('idempotency unavailable');
  }

  // ── Grant, THEN respond ──────────────────────────────────────────────────────
  // We own this event now. Only 200 after the grant actually lands, so a failure
  // returns 5xx and Dodo retries.
  try {
    const until = new Date(Date.now() + GRANT_DAYS * 864e5).toISOString();
    await premiumQueries.setTier(Number(telegramId), 'premium', until);
    logger.info(`Dodo ${type}: premium granted to ${telegramId} until ${until}`);

    // Best-effort notification; bot may not be ready during boot.
    try {
      const { alertAdmin } = require('../utils/adminAlert');
      alertAdmin('dodo', `💳 Dodo payment: premium granted to ${telegramId} (${type})`);
    } catch { /* non-fatal */ }

    return res.status(200).send('ok');
  } catch (err) {
    logger.error('Dodo webhook processing error:', err.message);
    // The grant failed AFTER we claimed the event. Release the claim so Dodo's
    // retry isn't permanently deduped into a no-op that never grants premium.
    try {
      await supabase.from('processed_webhook_events').delete().eq('event_id', msgId);
    } catch (delErr) {
      logger.error(`Dodo webhook: failed to release claim ${msgId} after grant error:`, delErr.message);
    }
    return res.status(500).send('processing failed');
  }
});

module.exports = router;
