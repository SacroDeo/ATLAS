// src/cron/reengagementCron.js
//
// Sympathetic "did you forget your goal?" re-engagement nudge.
//
// Fires for users who have gone quiet for several days mid-journey — distinct
// from day2RecoveryCron (which catches the day-1 → day-2 drop-off). The message
// is AI-generated and personalized to the user's actual goal, with a warm
// template fallback if the AI is unavailable.
//
// Trigger (both must hold):
//   1. It's been >= 3 days since the user last completed ANY task, AND
//   2. engagementAnalyzer.detectRelapseRisk() flags them as relapsing.
//
// Frequency: at most one nudge per inactivity spell. reengagement_nudge_sent_at
// blocks re-sends; it's cleared when the user completes a task (see
// taskService.handleTaskComplete), so the next lapse can nudge again. A 14-day
// cooldown also permits a re-nudge for users who stay away very long.

const cron = require('node-cron');
const userQueries = require('../database/queries/userQueries');
const taskQueries = require('../database/queries/taskQueries');
const engagementAnalyzer = require('../services/accountability/engagementAnalyzer');
const aiOrchestrator = require('../services/ai/aiOrchestrator');
const timezoneUtils = require('../utils/timezoneUtils');
const telegramClient = require('../utils/telegram/telegramClient');
const logger = require('../utils/logger');

const MIN_DAYS_SINCE_COMPLETION = 3;   // "a few days" gone quiet
const RENUDGE_COOLDOWN_DAYS = 14;      // don't re-nudge within this window
const SEND_WINDOW_START_HOUR = 10;     // user local time
const SEND_WINDOW_END_HOUR = 20;

class ReengagementCron {
  constructor(bot) {
    this.bot = bot;
    this.task = null;
  }

  start() {
    // Run every hour to catch each user during their local daytime window.
    this.task = cron.schedule('0 * * * *', async () => {
      try {
        await this.checkReengagement();
      } catch (error) {
        logger.error('Re-engagement cron failed:', error);
      }
    });

    logger.info('Re-engagement cron started');
  }

  async checkReengagement() {
    try {
      const users = await userQueries.getAllActiveUsers();

      for (const user of users) {
        try {
          await this.processUser(user);
        } catch (error) {
          logger.error(`Re-engagement check failed for user ${user.telegram_id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Re-engagement batch failed:', error);
    }
  }

  async processUser(user) {
    // Must be onboarded and have a goal to personalize around.
    if (!user.onboarding_completed) return;
    if (!user.goal) return;

    const userTz = user.timezone || 'UTC';

    // Only nudge during the user's local daytime — a sympathetic ping at 3am
    // is the opposite of caring.
    const currentHour = timezoneUtils.getCurrentTimeInZone(userTz).getHours();
    if (currentHour < SEND_WINDOW_START_HOUR || currentHour >= SEND_WINDOW_END_HOUR) return;

    // Frequency gate: skip if we nudged within the cooldown.
    if (user.reengagement_nudge_sent_at) {
      const daysSinceNudge =
        (Date.now() - new Date(user.reengagement_nudge_sent_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceNudge < RENUDGE_COOLDOWN_DAYS) return;
    }

    // Signal 1: days since last completion (timezone-aware date diff — do NOT
    // subtract raw timestamps, the completion is stored as an instant but we
    // compare calendar days in the user's zone).
    const lastCompletionDate = await taskQueries.getLastCompletionDate(user.id);
    if (!lastCompletionDate) return; // never completed anything — that's onboarding's job, not ours
    const today = timezoneUtils.getLocalDateString(userTz);
    const daysSinceLastCompletion = this._dayDiff(lastCompletionDate, today);
    if (daysSinceLastCompletion < MIN_DAYS_SINCE_COMPLETION) return;

    // Signal 2: engagement analyzer confirms a relapse pattern.
    const relapse = await engagementAnalyzer.detectRelapseRisk(user);
    if (!relapse.isRelapse) return;

    // Build the message: AI first, template fallback on any failure.
    let message;
    try {
      message = await aiOrchestrator.generateReengagementMessage(user, {
        daysSinceLastCompletion,
      });
    } catch (error) {
      logger.warn(`[Reengagement] AI generation failed for user ${user.telegram_id}, using template: ${error.message}`);
      message = this._buildTemplate(user, daysSinceLastCompletion);
    }

    try {
      await telegramClient.sendMessage(this.bot, user.telegram_id, message);
    } catch (error) {
      // Blocked / deleted account — mark inactive so we stop processing them.
      if (await userQueries.deactivateIfUnreachable(user.id, error)) {
        logger.info(`[Reengagement] User ${user.telegram_id} unreachable — marked inactive`);
      } else {
        logger.error(`[Reengagement] Failed to send nudge to ${user.telegram_id}:`, error);
      }
      return; // don't mark as sent if delivery failed
    }

    // Mark as sent so we don't nudge again until they re-engage (which clears
    // this) or the cooldown elapses.
    const { supabase } = require('../config/supabase');
    await supabase
      .from('users')
      .update({ reengagement_nudge_sent_at: new Date().toISOString() })
      .eq('id', user.id);

    logger.info(
      `[Reengagement] Nudge sent to user ${user.telegram_id} ` +
      `(daysSinceLastCompletion=${daysSinceLastCompletion}, relapse=${relapse.severity})`
    );
  }

  // Whole-day difference between two YYYY-MM-DD calendar-date strings.
  _dayDiff(fromDateStr, toDateStr) {
    const from = new Date(`${fromDateStr}T00:00:00Z`);
    const to = new Date(`${toDateStr}T00:00:00Z`);
    return Math.round((to - from) / (1000 * 60 * 60 * 24));
  }

  _buildTemplate(user, days) {
    const name = user.first_name || 'there';
    const goal = user.goal || 'your goal';
    return (
      `👋 Hey ${name} — I've missed you these last ${days} days.\n\n` +
      `No pressure and no guilt. I just remembered your goal: "${goal}". ` +
      `That version of you is still worth showing up for.\n\n` +
      `Want to take one small step back today? I'll keep it easy. 💛`
    );
  }

  stop() {
    if (this.task) {
      this.task.stop();
      logger.info('Re-engagement cron stopped');
    }
  }
}

module.exports = ReengagementCron;
