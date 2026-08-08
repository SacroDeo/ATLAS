// src/services/beta/groupMembership.js
// Beta-group membership → entitlements bridge.
//   Join  → auto-tag is_beta + grant 1 month free Pro (premium_source='group')
//   Leave → untag is_beta + revoke ONLY group-granted premium (paid/founding safe)
// Both the group event handlers (server.js) and the lazy /start catch-up call in.
const premiumQueries = require('../../database/queries/premiumQueries');
const telegramClient = require('../../utils/telegram/telegramClient');
const logger = require('../../utils/logger');
const config = require('../../config');

// Statuses that count as "in the group" per Telegram's getChatMember.
const MEMBER_STATUSES = ['creator', 'administrator', 'member', 'restricted'];

// Grant beta + 1 month Pro. Idempotent: re-running on an already-beta user just
// refreshes the row (the query keeps founding/paid premium intact). Sends a
// one-time-ish welcome DM only when premium was actually (re)granted from group.
// Returns true if a user row was updated, false if the person has no row yet
// (never pressed /start) — the caller can log that case.
async function grantGroupBeta(bot, telegramId) {
  const row = await premiumQueries.grantGroupBeta(telegramId);
  if (!row) {
    logger.info(`[betaGroup] Join by ${telegramId} but no user row yet — will catch up on /start`);
    return false;
  }
  logger.info(`[betaGroup] Granted beta+Pro to ${telegramId} (source=${row.premium_source}, tier=${row.tier})`);
  // DM the welcome. A group join is a private-DM-able event only if the user has
  // ever started the bot; wrap so a "bot can't initiate chat" error is non-fatal.
  try {
    await telegramClient.sendMessage(bot, telegramId,
      '🧪 *Welcome to the ATLAS beta!*\n\n' +
      "You've got *1 month of ATLAS Pro, free* — all features unlocked. 🚀\n\n" +
      'Use it for real, and tap /feedback anytime something is great, broken, or ' +
      'annoying. The most active testers earn *lifetime Pro*.\n\n' +
      'New here? Press /start to set up your goal.',
      { parse_mode: 'Markdown' });
  } catch (err) {
    logger.warn(`[betaGroup] Could not DM welcome to ${telegramId}: ${err.message}`);
  }
  return true;
}

// Revoke on leave: untag beta, strip premium ONLY if it came from the group.
// Silent by default (no DM) — a departure message would be noise. Returns true
// if group-granted premium was actually revoked.
async function revokeGroupBeta(bot, telegramId) {
  const revoked = await premiumQueries.revokeGroupBeta(telegramId);
  logger.info(`[betaGroup] Left group: ${telegramId} untagged` +
    (revoked ? ' + group Pro revoked' : ' (no group Pro to revoke)'));
  return Boolean(revoked);
}

// Lazy catch-up, called from /start. Covers people who were already in the
// group before this feature shipped, or who joined without a DB row (so the
// join event couldn't tag them). Only fires when a beta group is configured
// and the user isn't already beta — so it's at most one getChatMember call per
// user, and never again once they're granted. Failures are swallowed: a
// membership check must never break /start.
async function catchUpBetaOnStart(bot, user) {
  try {
    const gid = config.telegram.betaGroupId;
    if (!gid || !user || user.is_beta) return false;
    const member = await bot.getChatMember(gid, user.telegram_id);
    if (member && MEMBER_STATUSES.includes(member.status)) {
      return await grantGroupBeta(bot, user.telegram_id);
    }
    return false;
  } catch (err) {
    logger.warn(`[betaGroup] Catch-up check failed for ${user?.telegram_id}: ${err.message}`);
    return false;
  }
}

module.exports = { grantGroupBeta, revokeGroupBeta, catchUpBetaOnStart };
