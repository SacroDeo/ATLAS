// src/cron/dailyCron.js
// src/cron/dailyCron.js
const cron = require('node-cron');
const dailyTaskGenerator = require('../services/ai/dailyTaskGenerator');
const memoryService = require('../services/memory/memoryService');
const userQueries = require('../database/queries/userQueries');
const taskQueries = require('../database/queries/taskQueries');
const checkinQueries = require('../database/queries/checkinQueries');
const personalityService = require('../services/personality/personalityService');
const inlineKeyboards = require('../bot/keyboards/inlineKeyboards');
const timezoneUtils = require('../utils/timezoneUtils');
const telegramUtils = require('../utils/telegramUtils');
const logger = require('../utils/logger');
const telegramClient = require('../utils/telegram/telegramClient'); // ADD THIS LINE
const atlasCommands = require('../utils/atlasCommands');


class DailyCron {
  constructor() {
    this.bot = null;
    this.running = false;
    this.job = null;
    this.processingUsers = new Set();
  }

  setBot(bot) {
    this.bot = bot;
  }

  start() {
    if (!this.bot) {
      logger.warn('Bot instance not set for daily cron. Will attempt to find it.');
      const app = require('../../server');
      this.bot = app.bot;
    }

    this.job = cron.schedule('* * * * *', async () => {
      await this.checkAndSendTasks();
    }, {
      timezone: 'UTC'
    });

    this.running = true;
    logger.info('Daily cron job scheduled - checking every minute for per-user timezone-aware delivery');
  }

  async checkAndSendTasks() {
    try {
      const activeUsers = await userQueries.getAllActiveUsers();
      const eligibleUsers = [];

      for (const user of activeUsers) {
        if (!user.onboarding_completed) continue;
        if (!user.task_mode) continue;
        if (user.start_preference === 'manual') continue;
        if (this.processingUsers.has(user.telegram_id)) continue;

        const userTimezone = user.timezone || 'UTC';
        const userToday = timezoneUtils.getLocalDateString(userTimezone);

        // FIX: Check both the date flag AND whether tasks actually exist
        if (user.last_tasks_sent_date === userToday) {
          const existingTasks = await taskQueries.getDailyTasks(user.id, userToday);
          if (existingTasks && existingTasks.length > 0) {
            continue; // Tasks genuinely delivered
          }
          const pendingOld = await taskQueries.getPendingTasksBefore(user.id, userToday);
          if (pendingOld.length > 0) {
            // Waiting for user's skip/keep decision — don't re-ask. But a
            // frozen streak shouldn't survive the wait: no delivery means
            // processUser never evaluates yesterday, so an abandoned user
            // kept their streak forever. Reset once they're 2+ days idle.
            if ((user.current_streak || 0) > 0) {
              const twoDaysAgo = timezoneUtils.getLocalDateStringDaysAgo(userTimezone, 2);
              if ((user.last_tasks_sent_date || '') <= twoDaysAgo) {
                logger.info(`[checkAndSendTasks] User ${user.telegram_id} idle on pending-decision 2+ days — resetting streak`);
                await userQueries.resetStreak(user.id);
              }
            }
            continue;
          }
          logger.info(`[checkAndSendTasks] User ${user.telegram_id} has sent-date but no tasks — will retry`);
        }

        if (user.start_preference === 'tomorrow' && !user.last_tasks_sent_date) {
          if (user.created_at) {
            const createdDate = timezoneUtils.getLocalDateString(userTimezone, new Date(user.created_at));
            if (createdDate === userToday) continue;
          }
        }

        if (user.preferred_start_date && !user.last_tasks_sent_date) {
          const startDateObj = new Date(user.preferred_start_date);
          const userTodayObj = new Date(userToday);
          if (userTodayObj < startDateObj) continue;
        }

        if (timezoneUtils.shouldSendTasksNow(user)) {
          eligibleUsers.push(user);
        }
      }

      if (eligibleUsers.length > 0) {
        logger.info(`Found ${eligibleUsers.length} users eligible for task delivery`);
        for (const user of eligibleUsers) {
          await this.processEligibleUser(user);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    } catch (error) {
      logger.error('checkAndSendTasks execution failed:', error);
    }
  }

  // ─── FIXED: Only marks sent after confirmed success ────────────────────────
  async processEligibleUser(user) {
    const userTimezone = user.timezone || 'UTC';
    const userToday = timezoneUtils.getLocalDateString(userTimezone);

    if (this.processingUsers.has(user.telegram_id)) {
      logger.warn(`[processEligibleUser] User ${user.telegram_id} already being processed, skipping`);
      return;
    }

    this.processingUsers.add(user.telegram_id);

    try {
      const { supabase } = require('../config/supabase');
      await supabase
        .from('users')
        .update({ morning_answer_received_today: false })
        .eq('telegram_id', user.telegram_id);
      const freshUser = await userQueries.getUserByTelegramId(user.telegram_id);

      // FIX: Verify tasks actually exist before skipping
      if (freshUser && freshUser.last_tasks_sent_date === userToday) {
        const existingTasks = await taskQueries.getDailyTasks(freshUser.id, userToday);
        if (existingTasks && existingTasks.length > 0) {
          logger.info(`[processEligibleUser] User ${user.telegram_id} already has tasks for today, skipping`);
          return;
        }
        logger.info(`[processEligibleUser] User ${user.telegram_id} has sent-date but no tasks — retrying delivery`);
      }

      const result = await this.processUser(freshUser || user);

      // FIX: Only mark as sent if delivery actually succeeded
      if (result && result.success) {
        await userQueries.markTasksSentToday((freshUser || user).id, userToday);
        logger.info(`[processEligibleUser] Tasks sent and marked for user ${user.telegram_id} on ${userToday} (${result.tasksSent} tasks)`);
      } else {
        logger.warn(`[processEligibleUser] Delivery failed for user ${user.telegram_id} — NOT marking as sent. Error: ${result?.error || 'unknown'}`);
      }
    } catch (error) {
      logger.error(`[processEligibleUser] Failed for user ${user.telegram_id}:`, error);
      if (await userQueries.deactivateIfUnreachable(user.id, error)) {
        logger.info(`[processEligibleUser] User ${user.telegram_id} unreachable (blocked/deleted) — marked inactive`);
      }
    } finally {
      this.processingUsers.delete(user.telegram_id);
    }
  }

  // ─── FIXED: Verifies tasks exist before skipping, only marks after success ─
  async sendTasksImmediately(telegramId) {
    logger.info(`[sendTasksImmediately] Called for user ${telegramId}`);

    if (this.processingUsers.has(telegramId)) {
      logger.warn(`[sendTasksImmediately] User ${telegramId} already being processed, skipping`);
      return;
    }

    this.processingUsers.add(telegramId);
    logger.info(`[sendTasksImmediately] User ${telegramId} added to processing set`);

    try {
      let user = await userQueries.getUserByTelegramId(telegramId);
      logger.info(`[sendTasksImmediately] Fetched user: ${user ? 'found' : 'NOT FOUND'}, task_mode: ${user?.task_mode}`);

      // Re-fetch up to 3 times if task_mode not yet committed (race condition with onboarding save)
      if (user && !user.task_mode) {
        for (let i = 0; i < 3; i++) {
          await new Promise(resolve => setTimeout(resolve, 800));
          user = await userQueries.getUserByTelegramId(telegramId);
          logger.info(`[sendTasksImmediately] Re-fetch ${i+1}: task_mode=${user?.task_mode}`);
          if (user?.task_mode) break;
        }
      }

      if (!user) {
        logger.error(`[sendTasksImmediately] User ${telegramId} not found`);
        return;
      }

      const userTimezone = user.timezone || 'UTC';
      const userToday = timezoneUtils.getLocalDateString(userTimezone);

      // FIX: Verify tasks actually exist before skipping
      if (user.last_tasks_sent_date === userToday) {
        const existingTasks = await taskQueries.getDailyTasks(user.id, userToday);
        if (existingTasks && existingTasks.length > 0) {
          logger.info(`[sendTasksImmediately] User ${telegramId} already has ${existingTasks.length} tasks for today — skipping`);
          return;
        }
        logger.info(`[sendTasksImmediately] User ${telegramId} has sent-date but ZERO tasks in DB — forcing regeneration`);
      }

      logger.info(`[sendTasksImmediately] Processing user ${telegramId}, calling processUser`);
      const result = await this.processUser(user);

      // FIX: Only mark as sent if delivery actually succeeded
      if (result && result.success) {
        await userQueries.markTasksSentToday(user.id, userToday);
        logger.info(`[sendTasksImmediately] Tasks sent and marked for user ${telegramId} on ${userToday} (${result.tasksSent} tasks)`);
      } else {
        logger.warn(`[sendTasksImmediately] Delivery failed for user ${telegramId} — NOT marking as sent. Error: ${result?.error || 'unknown'}`);
      }
    } catch (error) {
      logger.error(`[sendTasksImmediately] Failed for ${telegramId}:`, error);
    } finally {
      this.processingUsers.delete(telegramId);
      logger.info(`[sendTasksImmediately] User ${telegramId} removed from processing set`);
    }
  }

  // ─── FIXED: Returns structured result { success, tasksSent, error } ────────
  async processUser(user) {
    logger.info(`[processUser] Starting for user ${user.telegram_id}, task_mode: ${user.task_mode}`);

    if (!this.bot) {
      logger.error('[processUser] Bot instance not available');
      return { success: false, tasksSent: 0, error: 'Bot instance not available' };
    }

    try {
      // "Yesterday" in the USER's timezone — server-clock yesterday can be
      // off by a day for users far from the server's zone.
      const yesterdayStr = timezoneUtils.getLocalDateStringDaysAgo(user.timezone || 'UTC', 1);

      const yesterdayTasks = await taskQueries.getDailyTasks(
        user.id,
        yesterdayStr
      );

      const completedYesterday = yesterdayTasks.filter(t => t.status === 'completed').length;
      const totalYesterday = yesterdayTasks.length;

      if (totalYesterday > 0 && completedYesterday === 0) {
        await this.handleNoCompletion(user);
      }

      if (totalYesterday > 0 && completedYesterday === totalYesterday) {
        const updated = await userQueries.updateStreak(user.id, true);
        // Keep the in-memory user in sync so sendDailyTasks renders today's
        // streak, not the stale pre-update value.
        if (updated) user.current_streak = updated.current_streak;
      } else if (totalYesterday > 0) {
        const completionRate = (completedYesterday / totalYesterday) * 100;
        if (completionRate < 50) {
          const updated = await userQueries.resetStreak(user.id);
          if (updated) user.current_streak = updated.current_streak;
        }
      }

      let tasks = [];

      if (!user.task_mode) {
        logger.info(`[processUser] User ${user.telegram_id} has no task_mode set — skipping until onboarding complete`);
        return { success: false, tasksSent: 0, error: 'task_mode not set' };
      }

      if (user.task_mode === 'ai') {
        const gateTz = user.timezone || 'UTC';
        const gateToday = timezoneUtils.getLocalDateString(gateTz);
        const pendingOld = await taskQueries.getPendingTasksBefore(user.id, gateToday);
        if (pendingOld.length > 0) {
          logger.info(`[processUser] User ${user.telegram_id} has ${pendingOld.length} pending old tasks — asking skip/keep instead of generating`);
          await this.sendPendingDecision(user, pendingOld);
          return { success: true, tasksSent: 0, error: null };
        }
        logger.info(`[processUser] User ${user.telegram_id} is AI mode, generating tasks`);
        tasks = await dailyTaskGenerator.generateTasksForUser(user.telegram_id, gateToday);
        logger.info(`[processUser] Generated ${tasks ? tasks.length : 0} tasks`);

        if (!tasks || tasks.length === 0) {
          logger.warn(`[processUser] No tasks generated, sending fallback`);
          await this.sendFallbackTasks(user);
          return { success: true, tasksSent: 3, error: null }; // fallback counts as success
        }

        logger.info(`[processUser] Sending ${tasks.length} tasks to Telegram`);
await this.sendDailyTasks(user, tasks);
logger.info(`[processUser] Tasks sent successfully`);
      } else {
        logger.info(`[processUser] User ${user.telegram_id} is manual mode, skipping task generation`);
        await this.sendMorningQuestion(user);
      }

      await checkinQueries.createCheckin(user.id, {
        type: 'daily',
        date: timezoneUtils.getLocalDateString(user.timezone || 'UTC'),
        response: `Tasks generated: ${tasks.length}`,
      });

      const daysSinceLastMemory = user.last_active
        ? Math.floor((new Date() - new Date(user.last_active)) / (1000 * 60 * 60 * 24))
        : 7;

      if (daysSinceLastMemory >= 7) {
        await memoryService.updateMemory(user.id, user.timezone || 'UTC');
      }

      logger.info(`[processUser] Daily tasks sent to user ${user.telegram_id}`);
      return { success: true, tasksSent: tasks.length, error: null };
    } catch (error) {
      logger.error(`[processUser] Failed to process user ${user.telegram_id}:`, error);
      // Send fallback tasks at most ONCE per user per day — the catch-up
      // window keeps retrying delivery every minute for up to 8h, which
      // used to re-send this fallback on every attempt.
      const fbKey = `${user.id}:${timezoneUtils.getLocalDateString(user.timezone || 'UTC')}`;
      if (!this.fallbackSent) this.fallbackSent = new Set();
      if (!this.fallbackSent.has(fbKey)) {
        this.fallbackSent.add(fbKey);
        if (this.fallbackSent.size > 5000) this.fallbackSent.clear(); // bound memory
        try {
          await this.sendFallbackTasks(user);
        } catch (fallbackError) {
          logger.error(`[processUser] Even fallback tasks failed for ${user.telegram_id}:`, fallbackError);
        }
      }
      return { success: false, tasksSent: 0, error: error.message };
    }
  }

  // Sends the ATLAS command list. Appended to every morning delivery so users
  // always have a way back to the commands without remembering /help. Failures
  // are swallowed — a missing footer must never break task delivery.
  async sendCommandsFooter(user) {
    try {
      await telegramClient.sendMessage(
        this.bot,
        user.telegram_id,
        atlasCommands.commandsFooter(),
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      logger.error(`Failed to send commands footer to ${user.telegram_id}:`, error);
    }
  }

  async sendPendingDecision(user, pendingTasks) {
    const list = pendingTasks
      .map((t, i) => `${i + 1}. ${t.title} (${t.assigned_date})`)
      .join('\n');
    await telegramClient.sendMessage(
      this.bot,
      user.telegram_id,
      `⏳ You still have unfinished tasks from before:\n\n${list}\n\nI won't generate new tasks until these are handled. What do you want to do?`,
      inlineKeyboards.pendingDecision()
    );
  }

  async handleNoCompletion(user) {
    const consecutiveMisses = await checkinQueries.getConsecutiveMisses(
      user.id,
      user.timezone || 'UTC'
    );

    if (consecutiveMisses >= 3) {
      try {
        await telegramClient.sendMessage(
          this.bot,
          user.telegram_id,
          `👋 Hey! I've noticed you've been away for ${consecutiveMisses} days.\n\n` +
          'What\'s blocking you right now?',
          inlineKeyboards.stuckCheckin()
        );
      } catch (error) {
        logger.error(`Failed to send stuck checkin to ${user.telegram_id}:`, error);
      }
    }
  }

  // ─── FIXED: Errors are THROWN, not swallowed ────────────────────────────────
  async sendDailyTasks(user, tasks) {
    logger.info(`[sendDailyTasks] Sending ${tasks.length} tasks to user ${user.telegram_id}`);

    try {
      const tone = personalityService.getPersonalityTone(user.personality_type);
      const taskIntro = personalityService.getTaskIntro(user.personality_type);
      // Re-send yesterday's still-pending tasks with action buttons
      const userTz = user.timezone || 'UTC';
      const yesterdayStr = timezoneUtils.getLocalDateStringDaysAgo(userTz, 1);
      const yesterdayTasks = await taskQueries.getDailyTasks(user.id, yesterdayStr);
      const pendingYesterday = yesterdayTasks.filter(t => t.status === 'pending');

      if (pendingYesterday.length > 0) {
        await telegramClient.sendMessage(
          this.bot,
          user.telegram_id,
          `⚠️ *Yesterday's unfinished tasks*\n\nComplete or skip these before asking for new ones:`,
          { parse_mode: 'MarkdownV2' }
        );

        for (const oldTask of pendingYesterday) {
          const oldKeyboard = inlineKeyboards.taskActions(oldTask.id);
          await telegramClient.sendMessage(
            this.bot,
            user.telegram_id,
            `↩️ *${telegramUtils.escapeMarkdown(oldTask.title)}*\n⏱️ ${telegramUtils.escapeMarkdown(oldTask.estimated_time || '')}`,
            {
              parse_mode: 'MarkdownV2',
              reply_markup: oldKeyboard.reply_markup,
            }
          );
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const greet = timezoneUtils.getGreeting(user.timezone);
      await telegramClient.sendMessage(
        this.bot,
        user.telegram_id,
        `${greet.emoji} *${telegramUtils.escapeMarkdown(greet.text)}\\!*\n\n🎯 *Today's Mission*\n${telegramUtils.escapeMarkdown(taskIntro)}`,
        { parse_mode: 'MarkdownV2' }
      );

      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const taskNumber = i + 1;

        const safeTitle = telegramUtils.escapeMarkdown(task.title);
        const safeDescription = telegramUtils.escapeMarkdown(task.description);
        const safeTime = telegramUtils.escapeMarkdown(task.estimated_time);
        const safeWhy = telegramUtils.escapeMarkdown(task.why_it_matters);
        const safeDifficulty = telegramUtils.escapeMarkdown(task.difficulty_level);

        const taskMessage =
          `*${taskNumber}\\. ${safeTitle}*\n\n` +
          `📝 *Instructions:*\n${safeDescription}\n\n` +
          `⏱️ *Time:* ${safeTime}\n` +
          `💡 *Why:* ${safeWhy}\n\n` +
          `📊 *Difficulty:* ${safeDifficulty}`;

        const keyboard = inlineKeyboards.taskActions(task.id);
        await telegramClient.sendMessage(
          this.bot,
          user.telegram_id,
          taskMessage,
          {
            parse_mode: 'MarkdownV2',
            reply_markup: keyboard.reply_markup,
          }
        );

        logger.info(`[sendDailyTasks] Sent task ${i + 1}/${tasks.length}: ${task.title}`);

        await new Promise(resolve => setTimeout(resolve, 800));
      }

      const safeEncouragement = telegramUtils.escapeMarkdown(tone.encouragement);

      // Social proof: show active user count
      const activeCount = await this.getActiveUsersToday();
      const socialProof = activeCount > 1
        ? `\n\n👥 ${activeCount} people are working on their goals with ATLAS right now.`
        : '';

      await telegramClient.sendMessage(
        this.bot,
        user.telegram_id,
        `${safeEncouragement}\n\n🔥 Current streak: ${user.current_streak} days${telegramUtils.escapeMarkdown(socialProof)}`,
        { parse_mode: 'MarkdownV2' }
      );

      await this.sendCommandsFooter(user);

      logger.info(`[sendDailyTasks] All tasks sent successfully to user ${user.telegram_id}`);
    } catch (error) {
      logger.error(`[sendDailyTasks] CRITICAL: Failed to send daily tasks to ${user.telegram_id}:`, error);
      // FIX: THROW the error so callers know delivery failed
      throw error;
    }
  }

  async sendMorningQuestion(user) {
    const MORNING_QUESTIONS = [
      "What's the one thing that would make today feel like a win for you?",
      "What's your energy level today — low, medium, or high?",
      "Is there anything blocking you from your goal right now?",
      "What's been your biggest challenge this week so far?",
      "How confident are you feeling about your progress today?",
      "What would you need to feel fully supported today?",
      "Any distractions or obstacles I should help you plan around today?",
      "On a scale of 1–5, how motivated are you feeling right now?",
      "What's one thing you're excited to tackle today?",
      "Is there a skill gap you're feeling stuck on lately?",
    ];

    try {
      const userTimezone = user.timezone || 'UTC';
      const userToday = timezoneUtils.getLocalDateString(userTimezone);

      if (user.last_morning_question_date === userToday) return;

      const name = user.first_name || 'there';

      const greet = timezoneUtils.getGreeting(userTimezone);
      await telegramClient.sendMessage(
        this.bot,
        user.telegram_id,
        `${greet.emoji} ${greet.text}, ${name}! How would you like your tasks today?`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '🤖 AI Generate My Tasks', callback_data: 'morning_pref_ai' },
              { text: '✏️ I\'ll Enter My Own', callback_data: 'morning_pref_manual' },
            ]]
          }
        }
      );

      await new Promise(resolve => setTimeout(resolve, 2000));

      const q = MORNING_QUESTIONS[Math.floor(Math.random() * MORNING_QUESTIONS.length)];
      await telegramClient.sendMessage(
        this.bot,
        user.telegram_id,
        `💬 Also — ${q}\n\nJust reply naturally — I'll keep it in mind all day.`,
        { parse_mode: 'Markdown' }
      );

      await this.sendCommandsFooter(user);

      const { supabase } = require('../config/supabase');
      await supabase
        .from('users')
        .update({
          last_morning_question_date: userToday,
          morning_answer_received_today: false,
        })
        .eq('telegram_id', user.telegram_id);

    } catch (error) {
      logger.error(`sendMorningQuestion failed for ${user.telegram_id}:`, error);
    }
  }

  async sendFallbackTasks(user) {
    try {
      await telegramClient.sendMessage(
        this.bot,
        user.telegram_id,
        `🎯 *Today's Focus*\n\n` +
        `Sorry, I couldn't generate personalized tasks today\\. Here's a general plan:\n\n` +
        `*1\\. Review Your Progress*\n` +
        `📝 Look at what you've learned so far and identify gaps\n` +
        `⏱️ Time: 30 minutes\n\n` +
        `*2\\. Practice Session*\n` +
        `📝 Spend focused time on your main skill\n` +
        `⏱️ Time: 45 minutes\n\n` +
        `*3\\. Plan Tomorrow*\n` +
        `📝 Write down 3 things you want to accomplish tomorrow\n` +
        `⏱️ Time: 10 minutes\n\n` +
        `I'll be back to normal tomorrow\\! 💪`,
        { parse_mode: 'MarkdownV2' }
      );
      await this.sendCommandsFooter(user);
    } catch (error) {
      logger.error(`Failed to send fallback tasks to ${user.telegram_id}:`, error);
    }
  }

  stop() {
    if (this.job) {
      this.job.stop();
      this.running = false;
      logger.info('Daily cron job stopped');
    }
  }

  // Social proof for the daily message. This is the one genuinely cross-user
  // aggregate in the codebase, so there is no single user-local "today" to key
  // it on — a server-UTC date would be some other user's yesterday. Use the
  // rolling 24h window on completed_at (a timestamptz, i.e. an absolute
  // instant) instead, which is also what the copy claims: "right now".
  //
  // It also counts DISTINCT users now. The old query counted task rows, so
  // one user finishing five tasks was announced as "5 people".
  async getActiveUsersToday() {
    try {
      const { supabase } = require('../config/supabase');
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from('tasks')
        .select('user_id')
        .eq('status', 'completed')
        .gte('completed_at', since)
        .limit(5000);

      if (error) throw error;
      return new Set((data || []).map(r => r.user_id)).size;
    } catch (error) {
      logger.error('Failed to get active user count:', error);
      return 0;
    }
  }
}

const dailyCron = new DailyCron();

process.on('SIGTERM', () => {
  dailyCron.stop();
});

module.exports = { dailyCron };
