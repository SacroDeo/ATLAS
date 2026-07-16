// src/cron/weeklyCron.js
const cron = require('node-cron');
const weeklyReviewGenerator = require('../services/ai/weeklyReviewGenerator');
const reviewService = require('../services/reviews/reviewService');
const memoryService = require('../services/memory/memoryService');
const userQueries = require('../database/queries/userQueries');
const personalityService = require('../services/personality/personalityService');
const telegramClient = require('../utils/telegram/telegramClient');
const logger = require('../utils/logger');

class WeeklyCron {
  constructor() {
    this.bot = null;
    this.running = false;
    this.job = null;
  }

  setBot(bot) {
    this.bot = bot;
  }

  start() {
    if (!this.bot) {
      logger.warn('Bot instance not set for weekly cron. Will attempt to find it.');
      const app = require('../../server');
      this.bot = app.bot;
    }

    this.job = cron.schedule('0 10 * * 0', async () => {
      logger.info('Weekly cron job started - generating reviews');
      await this.executeWeeklyReviews();
    }, {
      scheduled: true,
      timezone: 'UTC'
    });

    this.running = true;
    logger.info('Weekly cron job scheduled for Sundays at 10:00 AM UTC');
  }

  async executeWeeklyReviews() {
    try {
      const activeUsers = await userQueries.getInactiveUsers(0);
      
      logger.info(`Processing weekly reviews for ${activeUsers.length} active users`);

      for (const user of activeUsers) {
        await this.processUserReview(user);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      logger.info('Weekly review generation completed');
    } catch (error) {
      logger.error('Weekly cron execution failed:', error);
    }
  }

  async processUserReview(user) {
    try {
      const review = await weeklyReviewGenerator.generateReviewForUser(
        user.telegram_id,
        user
      );

      if (!review) {
        logger.info(`No review generated for user ${user.telegram_id} (insufficient data)`);
        return;
      }

      await memoryService.updateMemory(user.id);

      await this.sendWeeklyReview(user, review);

      logger.info(`Weekly review sent to user ${user.telegram_id}`);
    } catch (error) {
      logger.error(`Failed to process weekly review for user ${user.telegram_id}:`, error);
    }
  }

  async sendWeeklyReview(user, review) {
    try {
      const tone = personalityService.getPersonalityTone(user.personality_type);
      
      const reviewMessage = 
        `📊 *Weekly Performance Review*\n\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `📈 *Your Stats*\n` +
        `• Tasks Assigned: ${review.tasks_assigned}\n` +
        `• Completed: ${review.tasks_completed}\n` +
        `• Skipped: ${review.tasks_skipped}\n` +
        `• Completion Rate: ${review.completion_rate}%\n\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `${review.review_text}\n\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `💡 *Recommendations*\n${review.recommendations}\n\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `🏆 Best Day: ${review.best_day}\n` +
        `⚠️ Worst Day: ${review.worst_day}\n\n` +
        `${tone.encouragement}`;

      await telegramClient.sendMessage(
        this.bot,
        user.telegram_id,
        reviewMessage,
        { parse_mode: 'Markdown' }
      );

      await new Promise(resolve => setTimeout(resolve, 1500));

      const nextWeekMessage = this.getNextWeekMessage(review.completion_rate, user.personality_type);
      
      await telegramClient.sendMessage(
        this.bot,
        user.telegram_id,
        nextWeekMessage,
        { parse_mode: 'Markdown' }
      );

    } catch (error) {
      logger.error(`Failed to send weekly review to ${user.telegram_id}:`, error);
    }
  }

  getNextWeekMessage(completionRate, personalityType) {
    const rate = parseFloat(completionRate);
    
    if (rate >= 80) {
      const messages = {
        competitive: '🔥 Outstanding week! You\'re dominating. Next week, let\'s push even harder.',
        friendly: '🌟 Amazing work this week! You\'re doing so well. Let\'s keep this beautiful momentum going!',
        analytical: '📊 Excellent performance metrics. 80%+ completion rate is optimal. Maintain this trajectory.',
        gamified: '🏆 Legendary week! You\'ve unlocked the Consistency Badge. Ready for next week\'s challenges?',
      };
      return messages[personalityType] || messages.friendly;
    } else if (rate >= 50) {
      const messages = {
        competitive: '💪 Solid week. You\'re in the game but there\'s room to push harder. Let\'s step it up.',
        friendly: '👍 Good progress this week! A few areas to improve, but you\'re on the right track.',
        analytical: '📈 Moderate completion rate detected. Identify bottlenecks and optimize next week.',
        gamified: '⭐ Good quest completion! You\'re leveling up steadily. Aim for more quests next week.',
      };
      return messages[personalityType] || messages.friendly;
    } else {
      const messages = {
        competitive: '⚠️ Below target. Analyze what went wrong and come back stronger. No excuses.',
        friendly: '🤗 It was a tough week, wasn\'t it? That\'s okay. Let\'s start fresh on Monday with small steps.',
        analytical: '⚠️ Low completion rate. Recommend reducing task complexity by 30% for next week.',
        gamified: '🔄 Tough level this week. Don\'t give up! We\'ll adjust the difficulty and try again.',
      };
      return messages[personalityType] || messages.friendly;
    }
  }

  stop() {
    if (this.job) {
      this.job.stop();
      this.running = false;
      logger.info('Weekly cron job stopped');
    }
  }
}

const weeklyCron = new WeeklyCron();

process.on('SIGTERM', () => {
  weeklyCron.stop();
});

module.exports = { weeklyCron };