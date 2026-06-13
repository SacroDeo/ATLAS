// src/bot/commands/start.js
const userQueries = require('../../database/queries/userQueries');
const taskQueries = require('../../database/queries/taskQueries');
const dailyTaskGenerator = require('../../services/ai/dailyTaskGenerator');
const personalityService = require('../../services/personality/personalityService');
const inlineKeyboards = require('../keyboards/inlineKeyboards');
const logger = require('../../utils/logger');
const { safeSend, replyWithKeyboard } = require('../../utils/telegram/replyBuilder');
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
        await this.bot.sendMessage(
          chatId,
          'Welcome to ATLAS! Let me set up your profile.\n\nPlease wait a moment...'
        );
        return false;
      }

      if (!user.onboarding_completed) {
        return false;
      }

      const todayTasks = await taskQueries.getDailyTasks(user.id);

      if (todayTasks.length === 0) {
        await replyWithKeyboard(
          { reply: (text, opts) => this.bot.sendMessage(chatId, text, opts) },
          'You currently have no tasks for today.',
          inlineKeyboards.mainMenu()
        );
      } else {
        await this.sendTasks(chatId, todayTasks, user);
      }
      return true;
    } catch (error) {
      logger.error(`Start command error for ${telegramId}:`, error);
      await this.bot.sendMessage(
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
      
      await safeSend(
        { reply: (text, opts) => this.bot.sendMessage(chatId, text, opts) },
        message
      );
      return;
    }

    // Header message — single summary line
    const completedLine = completedTasks.length > 0 ? ` · ✅ ${completedTasks.length} done` : '';
    const skippedLine = skippedTasks.length > 0 ? ` · ⏭️ ${skippedTasks.length} skipped` : '';

    await safeSend(
      { reply: (text, opts) => this.bot.sendMessage(chatId, text, opts) },
      `🎯 *Today's Tasks — ${pendingTasks.length} pending*${completedLine}${skippedLine}`
    );

    // One message per task with action buttons
    for (let i = 0; i < pendingTasks.length; i++) {
      const task = pendingTasks[i];
      const taskMessage = formatTask(task, i + 1);

      try {
        await this.bot.sendMessage(chatId, taskMessage, {
          parse_mode: 'MarkdownV2',
          ...inlineKeyboards.taskActions(task.id),
        });
      } catch (err) {
        // Fallback without markdown if formatting fails
        logger.error(`Failed to send task ${task.id} with markdown:`, err);
        await this.bot.sendMessage(chatId, `${i + 1}. ${task.title}\n\n${task.description || ''}`, {
          ...inlineKeyboards.taskActions(task.id),
        });
      }
    }
  }
}

module.exports = StartCommand;