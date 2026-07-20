// src/services/premium/dodoService.js
// Dodo Payments (merchant of record) — international card payments.
// Dormant until env vars exist: DODO_API_KEY, DODO_PRODUCT_ID.
// Optional: DODO_ENV ('test'|'live', default live), DODO_WEBHOOK_SECRET.
//
// Flow: /paycard → createCheckout() → user pays on Dodo's hosted page →
// Dodo calls our webhook → tier flips to premium. Manual /verifypay never
// involved; Dodo handles cards, currency, and foreign tax compliance.
const logger = require('../../utils/logger');

function baseUrl() {
  return (process.env.DODO_ENV || 'live') === 'test'
    ? 'https://test.dodopayments.com'
    : 'https://live.dodopayments.com';
}

function enabled() {
  return Boolean(process.env.DODO_API_KEY && process.env.DODO_PRODUCT_ID);
}

// Creates a hosted checkout session; returns checkout_url or null.
// telegram_id rides in metadata so the webhook can map payment → user.
async function createCheckout(telegramId) {
  if (!enabled()) return null;
  try {
    const res = await fetch(`${baseUrl()}/checkouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DODO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_cart: [{ product_id: process.env.DODO_PRODUCT_ID, quantity: 1 }],
        metadata: { telegram_id: String(telegramId) },
        return_url: process.env.DASHBOARD_URL || undefined,
      }),
    });
    if (!res.ok) {
      logger.error(`Dodo checkout failed: ${res.status} ${await res.text()}`);
      return null;
    }
    const session = await res.json();
    return session.checkout_url || null;
  } catch (err) {
    logger.error('Dodo checkout error:', err.message);
    return null;
  }
}

module.exports = { enabled, createCheckout };
