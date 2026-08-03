// src/bot/callbacks/adminCallbacks.js
// Callback handlers for admin-only inline actions (the /beta roster buttons).
//
// SECURITY: callback_data is client-controlled and a button can be forwarded,
// so we NEVER trust the tap. Every action re-verifies that the person tapping
// (callbackQuery.from.id) is the configured admin before mutating anything.
const config = require('../../config');
const premiumQueries = require('../../database/queries/premiumQueries');
const { feedbackCommands } = require('../commands/feedbackCommands');
const telegramClient = require('../../utils/telegram/telegramClient');
const logger = require('../../utils/logger');

function adminId() {
  return config.telegram.adminId || process.env.ADMIN_TELEGRAM_ID;
}

module.exports = {
  async handle({ callbackQuery, ctx, action, id, extra }) {
    switch (action) {
      case 'betatag':
        return handleBetaTag({ callbackQuery, ctx, id, extra });
      default:
        throw new Error(`Unknown admin action: ${action}`);
    }
  },
};

// admin:betatag:<telegramId>:<0|1>  — 1 = mark beta, 0 = unmark.
async function handleBetaTag({ callbackQuery, ctx, id, extra }) {
  const bot = ctx.bot;
  const tapperId = callbackQuery.from && callbackQuery.from.id;
  const admin = adminId();

  // Hard admin gate — the whole point of re-checking here.
  if (!admin || String(tapperId) !== String(admin)) {
    await telegramClient.answerCallbackQuery(bot, callbackQuery.id, 'Not authorized.', true);
    return;
  }

  const targetId = Number(id);
  const makeBeta = extra === '1' || extra === 'true';
  if (!Number.isFinite(targetId)) {
    await telegramClient.answerCallbackQuery(bot, callbackQuery.id, 'Bad target id.', true);
    return;
  }

  let row;
  try {
    row = await premiumQueries.setBeta(targetId, makeBeta);
  } catch (err) {
    logger.error('[adminCallbacks] setBeta failed:', err);
    await telegramClient.answerCallbackQuery(bot, callbackQuery.id, 'DB error.', true);
    return;
  }

  if (!row) {
    await telegramClient.answerCallbackQuery(bot, callbackQuery.id, 'User not found.', true);
    return;
  }

  const who = row.first_name || (row.username ? `@${row.username}` : String(targetId));
  await telegramClient.answerCallbackQuery(
    bot,
    callbackQuery.id,
    makeBeta ? `🧪 ${who} marked beta` : `👤 ${who} unmarked`,
    false
  );

  // Re-render just THIS row's message in place so the 🧪/👤 tag, stats, and
  // button flip live. Default 21-day window matches the /beta command default.
  const chatId = callbackQuery.message && callbackQuery.message.chat.id;
  const messageId = callbackQuery.message && callbackQuery.message.message_id;
  try {
    await feedbackCommands.renderOneBetaRowEdit(bot, chatId, messageId, targetId);
  } catch (err) {
    // A failed re-render is non-fatal — the tag already applied; just log.
    logger.warn('[adminCallbacks] roster re-render failed:', err.message);
  }
}
