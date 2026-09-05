// src/bot/commands/start.js
const userQueries = require('../../database/queries/userQueries');
const taskQueries = require('../../database/queries/taskQueries');
const dailyTaskGenerator = require('../../services/ai/dailyTaskGenerator');
const personalityService = require('../../services/personality/personalityService');
const inlineKeyboards = require('../keyboards/inlineKeyboards');
const logger = require('../../utils/logger');
const timezoneUtils = require('../../utils/timezoneUtils');
const telegramClient = require('../../utils/telegram/telegramClient');
const groupMembership = require('../../services/beta/groupMembership');
const { formatTask, combineSections } = require('../../utils/telegram/telegramFormatter');

class StartCommand {
  constructor(bot) {
    this.bot = bot;
  }

  async execute(msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    try {
      const user = await userQueries.getUserByTelegramId(telegramId);

      if (!user) {
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          'Welcome to ATLAS! Let me set up your profile.\n\nPlease wait a moment...'
        );
        return false;
      }

      if (!user.onboarding_completed) {
        return false;
      }

      // Lazy beta catch-up: if this user is already in the beta group but wasn't
      // tagged at join time (joined before this feature, or had no row yet),
      // grant beta + 1 month Pro now. Fire-and-forget — never delays task delivery.
      groupMembership.catchUpBetaOnStart(this.bot, user).catch(() => {});

      const today = timezoneUtils.getLocalDateString(user.timezone || 'UTC');
      const todayTasks = await taskQueries.getDailyTasks(user.id, today);

      if (todayTasks.length === 0) {
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          'You currently have no tasks for today.',
          { reply_markup: inlineKeyboards.mainMenu().reply_markup }
        );
      } else {
        await this.sendTasks(chatId, todayTasks, user);
      }
      return true;
    } catch (error) {
      logger.error(`Start command error for ${telegramId}:`, error);
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        'Something went wrong. Please try again or contact support.'
      );
      return false;
    }
  }

  async sendTasks(chatId, tasks, user) {
    const tone = personalityService.getPersonalityTone(user.personality_type);

    const pendingTasks = tasks.filter(t => !t.status || t.status === 'pending');
    const completedTasks = tasks.filter(t => t.status === 'completed');
    const skippedTasks = tasks.filter(t => t.status === 'skipped');

    if (pendingTasks.length === 0) {
      const completedLine = completedTasks.length > 0 ? `✅ Completed: ${completedTasks.length}\n` : '';
      const skippedLine = skippedTasks.length > 0 ? `⏭️ Skipped: ${skippedTasks.length}\n` : '';
      
      const message = `🎉 *All tasks completed for today!*\n\n${completedLine}${skippedLine}${tone.encouragement}\n\nNew tasks arrive tomorrow.`;
      
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        message
      );
      return;
    }

    // Header message — single summary line
    const completedLine = completedTasks.length > 0 ? ` · ✅ ${completedTasks.length} done` : '';
    const skippedLine = skippedTasks.length > 0 ? ` · ⏭️ ${skippedTasks.length} skipped` : '';

    await telegramClient.sendMessage(
      this.bot,
      chatId,
      `🎯 *Today's Tasks — ${pendingTasks.length} pending*${completedLine}${skippedLine}`
    );

    // One message per task with action buttons
    for (let i = 0; i < pendingTasks.length; i++) {
      const task = pendingTasks[i];
      const taskMessage = formatTask(task, i + 1);

      try {
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          taskMessage,
          {
            parse_mode: 'MarkdownV2',
            ...inlineKeyboards.taskActions(task.id),
          }
        );
      } catch (err) {
        // Fallback without markdown if formatting fails
        logger.error(`Failed to send task ${task.id} with markdown:`, err);
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          `${i + 1}. ${task.title}\n\n${task.description || ''}`,
          inlineKeyboards.taskActions(task.id)
        );
      }
    }
  }
}

module.exports = StartCommand;