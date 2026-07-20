// src/bot/commands/feedbackCommands.js
// Beta feedback pipeline:
//   /feedback <text>  — any user; saved to Supabase AND forwarded to admin DM
//                       instantly, so the founder sees it in real time.
//   /betastats        — admin only; live beta health numbers from the DB.
const config = require('../../config');
const feedbackQueries = require('../../database/queries/feedbackQueries');
const telegramClient = require('../../utils/telegram/telegramClient');
const logger = require('../../utils/logger');

function adminId() {
  return config.telegram.adminId || process.env.ADMIN_TELEGRAM_ID;
}

const feedbackCommands = {
  async handleFeedback(bot, chatId, telegramId, args, user) {
    const text = (args || '').trim();
    if (!text) {
      await telegramClient.sendMessage(bot, chatId,
        '💬 Tell me what to pass on!\n\nUsage: /feedback your thoughts here\n\n' +
        'Bugs, annoyances, ideas, praise — everything helps ATLAS get better.');
      return;
    }
    const username = (user && user.username) || null;
    const row = await feedbackQueries.addFeedback(telegramId, username, text);

    // Real-time forward to the founder's own Telegram.
    const admin = adminId();
    if (admin && String(admin) !== String(telegramId)) {
      try {
        await telegramClient.sendMessage(bot, admin,
          `📣 *Feedback #${row.id}*\nFrom: ${telegramId}${username ? ` (@${username})` : ''}\n\n${text}`,
          { parse_mode: 'Markdown' });
      } catch (err) {
        logger.warn('Feedback admin forward failed:', err.message);
      }
    }
    await telegramClient.sendMessage(bot, chatId,
      '🙏 Got it — sent straight to the builder. Thank you for shaping ATLAS!');
  },

  async handleBetaStats(bot, chatId, telegramId) {
    const admin = adminId();
    if (!admin || String(telegramId) !== String(admin)) return false; // silent for non-admins
    const s = await feedbackQueries.betaStats();
    const fb = await feedbackQueries.countFeedback();
    await telegramClient.sendMessage(bot, chatId,
      `📊 *ATLAS Beta Stats*\n\n` +
      `👥 Total users: *${s.total}*\n` +
      `✅ Finished onboarding: *${s.onboarded}*\n` +
      `🔥 Active today: *${s.activeToday}*\n` +
      `📅 Active this week: *${s.activeWeek}*\n` +
      `💬 Feedback received: *${fb}*`,
      { parse_mode: 'Markdown' });
    return true;
  },
};

module.exports = { feedbackCommands };
