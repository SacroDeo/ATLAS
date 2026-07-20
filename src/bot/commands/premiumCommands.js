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

const PRICE_INR = 49;

function isAdmin(telegramId) {
  const adminId = config.telegram.adminId || process.env.ADMIN_TELEGRAM_ID;
  return adminId && String(telegramId) === String(adminId);
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
    // Strip ALL whitespace: codes never contain spaces, so "ABC 123" typed
    // with a stray space collapses to "ABC123" and still matches.
    const code = (args || '').replace(/\s+/g, '');
    if (!code) {
      await telegramClient.sendMessage(bot, chatId, 'Usage: /redeem YOURCODE');
      return true;
    }
    const coupon = await premiumQueries.redeemCoupon(code, telegramId);
    if (!coupon) {
      await telegramClient.sendMessage(bot, chatId, '❌ That code is invalid or has already been used.');
      return true;
    }
    const until = coupon.duration_days
      ? new Date(Date.now() + coupon.duration_days * 864e5).toISOString()
      : null;
    await premiumQueries.setTier(telegramId, coupon.grants_tier, until);
    await telegramClient.sendMessage(bot, chatId,
      coupon.grants_tier === 'founding'
        ? '🏆 *Founding Tester unlocked!*\n\nLifetime ATLAS Pro is yours. Thank you for building this with me.'
        : `⭐ *ATLAS Pro activated${coupon.duration_days ? ` for ${coupon.duration_days} days` : ''}!*`,
      { parse_mode: 'Markdown' });
    return true;
  },

  // /paid UPI_REF  (any user; logs claim + alerts admin DM)
  async handlePaid(bot, chatId, telegramId, args, user) {
    const ref = (args || '').trim();
    if (!ref) {
      await telegramClient.sendMessage(bot, chatId, 'Usage: /paid YOUR_UPI_REFERENCE_NUMBER');
      return true;
    }
    const row = await premiumQueries.logPayment(telegramId, PRICE_INR, ref);
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

  // Call before any Pro-gated feature. Returns true if a paywall was shown
  // (caller should stop). Never shows anything while payments are OFF.
  async maybeSendPaywall(bot, chatId, user, featureName) {
    if (!(await paywallVisible(user))) return false;
    await telegramClient.sendMessage(bot, chatId,
      `⭐ *${featureName}* is an ATLAS Pro feature\n\n` +
      `₹${PRICE_INR}/month — unlimited goals, full memory, deep reviews\n\n` +
      `1. Pay ₹${PRICE_INR} via UPI (QR: use /upgrade)\n` +
      `2. Send: /paid YOUR_UPI_REFERENCE\n` +
      `3. Pro activates within a few hours 🚀\n\n` +
      `Have a coupon? /redeem CODE`,
      { parse_mode: 'Markdown' });
    return true;
  },
};

module.exports = { premiumCommands, isAdmin, PRICE_INR };
