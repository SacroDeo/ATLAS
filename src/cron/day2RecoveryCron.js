// src/cron/day2RecoveryCron.js
const cron = require('node-cron');
const userQueries = require('../database/queries/userQueries');
const taskQueries = require('../database/queries/taskQueries');
const timezoneUtils = require('../utils/timezoneUtils');
const telegramClient = require('../utils/telegram/telegramClient');
const logger = require('../utils/logger');

class Day2RecoveryCron {
  constructor(bot) {
    this.bot = bot;
    this.task = null;
  }

  start() {
    // Run every hour to catch users in their local afternoon
    this.task = cron.schedule('0 * * * *', async () => {
      try {
        await this.checkDay2Recovery();
      } catch (error) {
        logger.error('Day-2 recovery cron failed:', error);
      }
    });

    logger.info('Day-2 recovery cron started');
  }

  async checkDay2Recovery() {
    try {
      const users = await userQueries.getAllActiveUsers();

      for (const user of users) {
        try {
          await this.processUser(user);
        } catch (error) {
          logger.error(`Day-2 recovery check failed for user ${user.telegram_id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Day-2 recovery batch failed:', error);
    }
  }

  async processUser(user) {
    // Skip if already sent
    if (user.day2_recovery_sent_at) return;

    // Skip if not onboarded
    if (!user.onboarding_completed) return;

    const userTz = user.timezone || 'UTC';
    const now = timezoneUtils.getCurrentTimeInZone(userTz);
    const currentHour = now.getHours();

    // Only send in afternoon hours (14:00 - 18:00 local time)
    if (currentHour < 14 || currentHour >= 18) return;

    const today = now.toISOString().split('T')[0];
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // Check if user completed at least one task yesterday (day 1)
    const completedYesterday = await taskQueries.hasCompletedTasksOnDate(user.id, yesterdayStr);
    if (!completedYesterday) return;

    // Check if user has done NOTHING today (day 2)
    const completedToday = await taskQueries.hasCompletedTasksOnDate(user.id, today);
    if (completedToday) return;

    // Check if user has any tasks assigned today
    const todayTasks = await taskQueries.getDailyTasks(user.id, today);
    if (todayTasks.length === 0) return;

    // Send the recovery nudge
    const message =
      `👋 Hey — you crushed it yesterday.\n\n` +
      `Day 2 is where most people ghost. Don't be most people.\n\n` +
      `You've got ${todayTasks.length} task${todayTasks.length > 1 ? 's' : ''} waiting. ` +
      `Just do one. That's all it takes to stay in the game.`;

    await telegramClient.sendMessage(this.bot, user.telegram_id, message);

    // Mark as sent
    const { supabase } = require('../config/supabase');
    await supabase
      .from('users')
      .update({ day2_recovery_sent_at: new Date().toISOString() })
      .eq('id', user.id);

    logger.info(`Day-2 recovery nudge sent to user ${user.telegram_id}`);
  }

  stop() {
    if (this.task) {
      this.task.stop();
      logger.info('Day-2 recovery cron stopped');
    }
  }
}

module.exports = Day2RecoveryCron;
