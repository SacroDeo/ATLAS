// src/bot/commands/premiumCommands.js
// All premium/payment commands in one place:
//   Admin (silent to everyone else): /payments, /makecoupon, /verifypay
//   Users: /redeem CODE, /paid UPI_REF
// Plus maybeSendPaywall(), the ONLY place premium UI is ever shown.
// While payments are OFF (app_settings.payments_enabled = false), users see
// nothing premium-related anywhere — full ATLAS free (beta mode).

const config = require('../../config');
const premiumQueries = require('../../database/queries/premiumQueries');
const { paymentsEnabled, paywallVisible, invalidateSettingsCache } = require('../../services/premium/entitlements');
const telegramClient = require('../../utils/telegram/telegramClient');
const logger = require('../../utils/logger');
const rateLimiter = require('../../services/ai/rateLimiter');

const PRICE_INR = 49;

function isAdmin(telegramId) {
  const adminId = config.telegram.adminId || process.env.ADMIN_TELEGRAM_ID;

  // Fail closed if admin ID is not configured
  if (!adminId) {
    logger.error('SECURITY: ADMIN_TELEGRAM_ID not configured - admin commands disabled');
    return false;
  }

  // Validate admin ID format (must be numeric)
  if (!/^\d+$/.test(String(adminId))) {
    logger.error('SECURITY: ADMIN_TELEGRAM_ID is invalid - must be numeric');
    return false;
  }

  const isAuthorized = String(telegramId) === String(adminId);

  // Log failed admin attempts for security monitoring
  if (!isAuthorized && telegramId) {
    logger.warn(`SECURITY: Non-admin ${telegramId} attempted admin action`);
  }

  return isAuthorized;
}

const premiumCommands = {
  // /payments on | off | status  (admin-only; silent for others)
  async handlePaymentsToggle(bot, chatId, telegramId, args) {
    if (!isAdmin(telegramId)) return false;
    const arg = (args || '').trim().toLowerCase();
    if (arg === 'on' || arg === 'off') {
      await premiumQueries.setPaymentsEnabled(arg === 'on');
      invalidateSettingsCache();
      await telegramClient.sendMessage(bot, chatId, `💳 Payments are now *${arg.toUpperCase()}*`, { parse_mode: 'Markdown' });
    } else {
      const on = await paymentsEnabled();
      await telegramClient.sendMessage(bot, chatId,
        `💳 Payments: *${on ? 'ON' : 'OFF'}*\n\nTap one: /paymentson · /paymentsoff · /paymentsstatus`,
        { parse_mode: 'Markdown' });
    }
    return true;
  },

  // /makecoupon CODE [days]  (admin-only; lifetime founding coupon if days omitted)
  async handleMakeCoupon(bot, chatId, telegramId, args) {
    if (!isAdmin(telegramId)) return false;
    // days is a trailing number if present; everything before it is the code.
    // Any spaces the admin fat-fingers into the code get stripped so it matches
    // what /redeem will accept (both sides remove whitespace).
    const parts = (args || '').trim().split(/\s+/);
    let days = null;
    if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
      days = parts.pop();
    }
    const code = parts.join('');
    if (!code) {
      await telegramClient.sendMessage(bot, chatId, 'Usage: /makecoupon CODE [days]\nUse ONE word, no spaces — e.g. /makecoupon TESTERRAHUL\nOmit days for lifetime founding coupon.');
      return true;
    }
    try {
      await premiumQueries.createCoupon(code, 'founding', days ? parseInt(days, 10) : null);
      await telegramClient.sendMessage(bot, chatId,
        `🎟️ Coupon *${code.toUpperCase()}* created (${days ? days + ' days' : 'lifetime founding'})`,
        { parse_mode: 'Markdown' });
    } catch (err) {
      // Duplicate code is the common failure — surface it plainly.
      await telegramClient.sendMessage(bot, chatId, `⚠️ Could not create coupon: ${err.message}`);
    }
    return true;
  },

  // /verifypay PAYMENT_ID ok|no  (admin-only)
  async handleVerifyPay(bot, chatId, telegramId, args) {
    if (!isAdmin(telegramId)) return false;
    const [id, verdict] = (args || '').trim().split(/\s+/);
    if (!id || !['ok', 'no'].includes(verdict)) {
      await telegramClient.sendMessage(bot, chatId, 'Usage: /verifypay PAYMENT_ID ok|no');
      return true;
    }
    const row = await premiumQueries.verifyPayment(parseInt(id, 10), verdict === 'ok');
    if (!row) {
      await telegramClient.sendMessage(bot, chatId, `Payment ${id} not found or already handled.`);
      return true;
    }
    await telegramClient.sendMessage(bot, chatId,
      verdict === 'ok' ? `✅ Payment ${id} verified — premium granted to ${row.telegram_id}` : `❌ Payment ${id} rejected`);
    if (verdict === 'ok') {
      // Tell the user their Pro is live.
      try {
        await telegramClient.sendMessage(bot, row.telegram_id,
          '⭐ *ATLAS Pro activated!* Your payment is verified. Enjoy 🚀', { parse_mode: 'Markdown' });
      } catch (err) {
        logger.warn('Could not notify user of premium activation:', err.message);
      }
    }
    return true;
  },

  // /redeem CODE  (any user; OTP-style single use, atomic)
  async handleRedeem(bot, chatId, telegramId, args) {
    // Rate limiting to prevent coupon enumeration attacks
    const rateCheck = rateLimiter.checkCouponAttempt(telegramId);
    if (!rateCheck.allowed) {
      await telegramClient.sendMessage(bot, chatId,
        `⏳ Too many redemption attempts. Please wait ${rateLimiter.formatRetryTime(rateCheck.retryAfterSeconds)} before trying again.`);
      logger.warn(`SECURITY: Coupon rate limit hit by ${telegramId}`);
      return true;
    }

    // Strip ALL whitespace: codes never contain spaces, so "ABC 123" typed
    // with a stray space collapses to "ABC123" and still matches.
    const code = (args || '').replace(/\s+/g, '');
    if (!code) {
      await telegramClient.sendMessage(bot, chatId, 'Usage: /redeem YOURCODE');
      return true;
    }
    const coupon = await premiumQueries.redeemCoupon(code, telegramId);
    if (!coupon) {
      // Uniform error message to prevent enumeration - don't reveal if code exists
      const existing = await premiumQueries.getCoupon(code);

      // Log for security monitoring
      if (existing) {
        if (String(existing.redeemed_by) === String(telegramId)) {
          logger.info(`User ${telegramId} tried to re-redeem their own code ${code}`);
        } else {
          logger.warn(`SECURITY: User ${telegramId} attempted already-used code ${code}`);
        }
      } else {
        logger.info(`User ${telegramId} tried invalid code ${code}`);
      }

      // Generic error message prevents enumeration
      await telegramClient.sendMessage(bot, chatId,
        '❌ Invalid or unavailable code. Check the spelling and try again.');
      return true;
    }
    const until = coupon.duration_days
      ? new Date(Date.now() + coupon.duration_days * 864e5).toISOString()
      : null;
    await premiumQueries.setTier(telegramId, coupon.grants_tier, until);
    logger.info(`User ${telegramId} successfully redeemed coupon ${code} (${coupon.grants_tier})`);
    await telegramClient.sendMessage(bot, chatId,
      coupon.grants_tier === 'founding'
        ? '🏆 *Founding Tester unlocked!*\n\nLifetime ATLAS Pro is yours. Thank you for building this with me.'
        : `⭐ *ATLAS Pro activated${coupon.duration_days ? ` for ${coupon.duration_days} days` : ''}!*`,
      { parse_mode: 'Markdown' });
    return true;
  },

  // /paid UPI_REF  (any user; logs claim + alerts admin DM)
  async handlePaid(bot, chatId, telegramId, args, user) {
    // Rate limiting to prevent spam attacks
    const rateCheck = rateLimiter.checkPaymentClaim(telegramId);
    if (!rateCheck.allowed) {
      await telegramClient.sendMessage(bot, chatId,
        `⏳ Too many payment claims. Please wait ${rateLimiter.formatRetryTime(rateCheck.retryAfterSeconds)} before trying again. If you've already submitted your payment, it's being verified.`);
      logger.warn(`SECURITY: Payment claim rate limit hit by ${telegramId}`);
      return true;
    }

    const ref = (args || '').trim();
    if (!ref) {
      await telegramClient.sendMessage(bot, chatId, 'Usage: /paid YOUR_UPI_REFERENCE_NUMBER');
      return true;
    }

    // Input validation to prevent injection attacks
    if (ref.length < 6 || ref.length > 50) {
      await telegramClient.sendMessage(bot, chatId,
        '❌ Invalid UPI reference. It should be 6-50 characters long.');
      logger.warn(`SECURITY: Invalid UPI ref length from ${telegramId}: ${ref.length} chars`);
      return true;
    }

    // Only allow alphanumeric + basic symbols (no special chars that could be injection vectors)
    if (!/^[a-zA-Z0-9\-_.]+$/.test(ref)) {
      await telegramClient.sendMessage(bot, chatId,
        '❌ Invalid UPI reference format. Use only letters, numbers, hyphens, underscores, and dots.');
      logger.warn(`SECURITY: Invalid UPI ref format from ${telegramId}: ${ref}`);
      return true;
    }

    const row = await premiumQueries.logPayment(telegramId, PRICE_INR, ref);
    logger.info(`Payment claim #${row.id} from ${telegramId}: ${ref}`);

    const adminId = config.telegram.adminId || process.env.ADMIN_TELEGRAM_ID;
    if (adminId) {
      try {
        await telegramClient.sendMessage(bot, adminId,
          `💰 *Payment claim #${row.id}*\nUser: ${telegramId} (@${(user && user.username) || '—'})\nAmount: ₹${PRICE_INR}\nRef: \`${ref}\`\n\nVerify: /verifypay ${row.id} ok`,
          { parse_mode: 'Markdown' });
      } catch (err) {
        logger.error('Admin payment alert failed:', err.message);
      }
    }
    await telegramClient.sendMessage(bot, chatId,
      '🕐 Got it! Your payment is being verified — Pro activates within a few hours.');
    return true;
  },

  // /upgrade — the storefront. Shows price + UPI payment instructions.
  // Payments OFF → tells the user ATLAS is fully free right now.
  // Already premium → congratulates instead of asking for money.
  async handleUpgrade(bot, chatId, telegramId, user) {
    const { isPremium } = require('../../services/premium/entitlements');
    if (!(await paymentsEnabled())) {
      await telegramClient.sendMessage(bot, chatId,
        '🎉 Good news — ATLAS is *completely free* right now.\nAll features, no payment needed. Enjoy!',
        { parse_mode: 'Markdown' });
      return true;
    }
    if (await isPremium(user)) {
      await telegramClient.sendMessage(bot, chatId,
        '⭐ You already have *ATLAS Pro*. Nothing to upgrade — go crush your goals!',
        { parse_mode: 'Markdown' });
      return true;
    }
    // QR image, not a UPI ID string — a raw UPI ID exposes the owner's phone
    // number as copyable text; the QR keeps it scannable-only.
    const fs = require('fs');
    const path = require('path');
    const qrPath = path.join(__dirname, '../../../assets/upi-qr.png');
    const caption =
      `⭐ *ATLAS Pro* — ₹${PRICE_INR}/month\n\n` +
      `• Unlimited goals\n• Full long-term memory\n• Deep weekly reviews\n• Priority AI\n\n` +
      `Scan the QR with any UPI app (GPay, PhonePe, Paytm) and pay ₹${PRICE_INR}\n\n` +
      `Then send: /paid YOUR_UPI_REFERENCE\nPro activates within a few hours 🚀\n\n` +
      `🌍 Outside India? Pay by card: /paycard\n` +
      `Have a coupon? /redeem CODE`;
    if (fs.existsSync(qrPath)) {
      await bot.sendPhoto(chatId, qrPath, { caption, parse_mode: 'Markdown' });
    } else {
      // QR not uploaded yet — never show a broken storefront.
      await telegramClient.sendMessage(bot, chatId,
        `⭐ *ATLAS Pro* — ₹${PRICE_INR}/month\n\nPayment details are being set up — check back soon!`,
        { parse_mode: 'Markdown' });
    }
    return true;
  },

  // /couponlist — admin-only coupon ledger: every code, its status, who
  // redeemed it and when. This IS the "proof and record" of coupons given.
  async handleCouponList(bot, chatId, telegramId) {
    if (!isAdmin(telegramId)) return false;
    const coupons = await premiumQueries.listCoupons();
    if (!coupons.length) {
      await telegramClient.sendMessage(bot, chatId, 'No coupons created yet. Use /makecoupon CODE');
      return true;
    }
    const lines = coupons.map((c) => {
      const life = c.duration_days ? `${c.duration_days}d` : 'lifetime';
      return c.redeemed_by
        ? `✅ ${c.code} (${life}) → ${c.redeemed_by} on ${new Date(c.redeemed_at).toLocaleDateString('en-IN')}`
        : `🎟️ ${c.code} (${life}) — unused`;
    });
    await telegramClient.sendMessage(bot, chatId,
      `📒 *Coupon ledger* (latest 50)\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown' });
    return true;
  },

  // /paycard — international card payment via Dodo (merchant of record).
  // Generates a personal hosted-checkout link; webhook auto-activates Pro.
  async handlePayCard(bot, chatId, telegramId, user) {
    const dodo = require('../../services/premium/dodoService');
    const { isPremium } = require('../../services/premium/entitlements');
    if (!(await paymentsEnabled())) {
      await telegramClient.sendMessage(bot, chatId,
        '🎉 ATLAS is *completely free* right now — no payment needed!',
        { parse_mode: 'Markdown' });
      return true;
    }
    if (await isPremium(user)) {
      await telegramClient.sendMessage(bot, chatId,
        '⭐ You already have *ATLAS Pro*!', { parse_mode: 'Markdown' });
      return true;
    }
    if (!dodo.enabled()) {
      await telegramClient.sendMessage(bot, chatId,
        '💳 Card payments are coming soon! For now, Indian users can pay via /upgrade (UPI).');
      return true;
    }
    const url = await dodo.createCheckout(telegramId);
    if (!url) {
      await telegramClient.sendMessage(bot, chatId,
        '😅 Could not create a checkout link right now — please try again in a bit.');
      return true;
    }
    await telegramClient.sendMessage(bot, chatId,
      `⭐ *ATLAS Pro* — $9.99/month\n\n` +
      `Pay securely by card (Visa/Mastercard/Amex, any currency):`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '💳 Pay with card', url }]] },
      });
    return true;
  },

  // /resetpremium [telegram_id] — admin-only; resets premium status for testing
  // Without args, resets own premium. With telegram_id, resets that user's premium.
  async handleResetPremium(bot, chatId, telegramId, args) {
    if (!isAdmin(telegramId)) return false;

    const targetId = (args || '').trim() || String(telegramId);

    // Validate it's a numeric telegram ID
    if (!/^\d+$/.test(targetId)) {
      await telegramClient.sendMessage(bot, chatId,
        'Invalid telegram ID. Usage: /resetpremium [TELEGRAM_ID]');
      return true;
    }

    try {
      // Reset premium tier
      await premiumQueries.setTier(targetId, 'free', null);

      logger.info(`Admin ${telegramId} reset premium for user ${targetId}`);

      await telegramClient.sendMessage(bot, chatId,
        `✅ Premium status reset for user ${targetId}\n\n` +
        `Tier: free\nPremium until: null\n\n` +
        `The user can now test /upgrade, /redeem, and payment flows.`,
        { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`Failed to reset premium for ${targetId}:`, err);
      await telegramClient.sendMessage(bot, chatId,
        `❌ Failed to reset premium: ${err.message}`);
    }

    return true;
  },

  // Call before any Pro-gated feature. Returns true if a paywall was shown
  // (caller should stop). Never shows anything while payments are OFF.
  async maybeSendPaywall(bot, chatId, user, featureName) {
    if (!(await paywallVisible(user))) return false;
    await telegramClient.sendMessage(bot, chatId,
      `⭐ *${featureName}* is an ATLAS Pro feature\n\n` +
      `₹${PRICE_INR}/month — unlimited goals, full memory, deep reviews\n\n` +
      `1. Tap /upgrade for payment details\n` +
      `2. Send: /paid YOUR_UPI_REFERENCE\n` +
      `3. Pro activates within a few hours 🚀\n\n` +
      `Have a coupon? /redeem CODE`,
      { parse_mode: 'Markdown' });
    return true;
  },
};

module.exports = { premiumCommands, isAdmin, PRICE_INR };
