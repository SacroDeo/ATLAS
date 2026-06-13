// src/bot/handlers/callbackHandler.js
const callbackRouter = require('../callbacks/callbackRouter');
const aiOrchestrator = require('../../services/ai/aiOrchestrator');
const taskService = require('../../services/tasks/taskService');
const userQueries = require('../../database/queries/userQueries');
const taskQueries = require('../../database/queries/taskQueries');
const socraticEvaluator = require('../../services/ai/socraticEvaluator');
const socraticQueries = require('../../database/queries/socraticQueries');
const checkinQueries = require('../../database/queries/checkinQueries');
const personalityService = require('../../services/personality/personalityService');
const reviewQueries = require('../../database/queries/reviewQueries');
const reviewService = require('../../services/reviews/reviewService');
const memoryQueries = require('../../database/queries/memoryQueries');
const dateUtils = require('../../utils/dateUtils');
const timezoneUtils = require('../../utils/timezoneUtils');
const telegramUtils = require('../../utils/telegramUtils');
const inlineKeyboards = require('../keyboards/inlineKeyboards');
const logger = require('../../utils/logger');
const { telegramErrorHandler } = require('../../utils/errorHandler');
const { dailyCron } = require('../../cron/dailyCron');
const { isLowInformationAnswer } = require('../../utils/validators');

class CallbackHandler {
  constructor(bot) {
    this.bot = bot;
    this.onboardingFlow = null;
    this.callbackHandler = null;
    this.messageHandler = null;
    
    // FIX 1: Map with TTL-based deduplication using callback query ID
    this.processedCallbacks = new Map();
    this.callbackTTL = 5 * 60 * 1000;

    // FIX 2: Proper cleanup interval
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.processedCallbacks.entries()) {
        if (now - value.timestamp > this.callbackTTL) {
          this.processedCallbacks.delete(key);
        }
      }
    }, 60000);
  }

  // FIX: Cleanup method for process reloads
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  setCallbackHandler(callbackHandler) {
    this.callbackHandler = callbackHandler;
  }

  setOnboardingFlow(onboardingFlow) {
    this.onboardingFlow = onboardingFlow;
  }

  setMessageHandler(messageHandler) {
    this.messageHandler = messageHandler;
  }


async _getCallbackContext(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const telegramId = callbackQuery.from.id;

  const user = await userQueries.getUserByTelegramId(telegramId);

  if (!user) {
    throw new Error(`User not found for telegram ID ${telegramId}`);
  }

  return {
    chatId,
    messageId,
    telegramId,
    user,
  };
}



async handleCallback(callbackQuery) {
  try {
    await callbackRouter.route(callbackQuery, this);
  } catch (error) {
    logger.error('Callback error:', error);

    try {
      await this.bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Something went wrong.',
        show_alert: false,
      });
    } catch (_) {}
  }
}


async handleChangeTimeConfirm(
  callbackQuery,
  time
) {

  const { chatId, messageId, user } =
    await this._getCallbackContext(
      callbackQuery
    );

  if (time === 'custom') {

    if (
      this.messageHandler &&
      this.messageHandler.activeStates
    ) {
      this.messageHandler.activeStates.set(
        user.telegram_id,
        'awaiting_custom_time_change'
      );
    }

    await this.bot.editMessageText(
      '✏️ Please reply with your preferred time.',
      {
        chat_id: chatId,
        message_id: messageId,
      }
    );

    return;
  }

  try {

    await userQueries.updateOnboardingState(
      user.telegram_id,
      'completed',
      {
        preferred_time: time,
      }
    );

    const safeTime =
      telegramUtils.escapeMarkdown(time);

    await this.bot.editMessageText(
      `✅ Time updated to *${safeTime}*`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'MarkdownV2',
      }
    );

  } catch (error) {

    logger.error(
      `Change time failed for ${user.telegram_id}:`,
      error
    );

    await this.bot.editMessageText(
      '❌ Failed to update time.',
      {
        chat_id: chatId,
        message_id: messageId,
      }
    );
  }
}

    async _handleMenuAction(callbackQuery, action) {
    const { chatId, messageId, user } = await this._getCallbackContext(callbackQuery);

    switch (action) {
      case 'progress':
        return this.showProgress(chatId, messageId, user);
      case 'stats':
        return this.showStats(chatId, messageId, user);
      case 'goal':
        return this.showGoal(chatId, messageId, user);
      case 'review':
        return this.showReview(chatId, messageId, user);
      case 'help':
        return this.showHelp(chatId, messageId);
      default:
        logger.warn(`[menu] Unknown menu action: ${action}`);
    }
  }

  // FIX 5: answerCallbackQuery at START, callbackQuery passed as param
  async handleTasksNow(chatId, messageId, user, callbackQuery) {
    await this.bot.answerCallbackQuery(callbackQuery.id);

    try {
      const userTimezone = user.timezone || 'UTC';
      const userNow = timezoneUtils.getCurrentTimeInZone(userTimezone);
      const userToday = userNow.toISOString().split('T')[0];

      if (user.last_tasks_sent_date === userToday) {
        await this.bot.editMessageText(
          '✅ You already have your tasks for today\\!',
          { chat_id: chatId, message_id: messageId, parse_mode: 'MarkdownV2' }
        );
        return;
      }

      await this.bot.editMessageText(
        '🚀 Generating your tasks right now\\.\\.\\.',
        { chat_id: chatId, message_id: messageId, parse_mode: 'MarkdownV2' }
      );

      await dailyCron.sendTasksImmediately(user.telegram_id);

      if (user.start_preference === 'manual') {
        await userQueries.updateOnboardingState(user.telegram_id, 'completed', {
          start_preference: 'today',
        });
      }

      await this.bot.editMessageText(
        '✨ Your tasks are ready\\! Check above to start working on them\\.',
        { chat_id: chatId, message_id: messageId, parse_mode: 'MarkdownV2' }
      );
    } catch (error) {
      logger.error(`Tasks now failed for ${user.telegram_id}:`, error);
      await this.bot.editMessageText(
        '❌ Failed to generate tasks. Please try again.',
        { chat_id: chatId, message_id: messageId }
      );
    }
  }

  async handleTasksScheduled(chatId, messageId) {
    await this.bot.editMessageText(
      '✅ Tasks will arrive at your scheduled time\\.', 
      { chat_id: chatId, message_id: messageId, parse_mode: 'MarkdownV2' }
    );
  }

async handleDeleteConfirm(
  callbackQuery,
  taskId
) {

  const { chatId, messageId } =
    await this._getCallbackContext(
      callbackQuery
    );

  const task =
    await taskQueries.getTaskById(taskId);

  if (!task) {
    return;
  }

  await taskQueries.deleteTask(taskId);

  await this.bot.editMessageText(
    `✅ Task "${task.title}" removed.`,
    {
      chat_id: chatId,
      message_id: messageId,
    }
  );
}


  async handleDeleteCancel(chatId, messageId) {
    await this.bot.editMessageText(
      'Deletion cancelled.',
      { chat_id: chatId, message_id: messageId }
    );
  }

  // FIX 5: answerCallbackQuery moved to START
async handleDone(callbackQuery, taskId) {
  const { chatId, messageId, user } =
    await this._getCallbackContext(callbackQuery);

  await this.bot.answerCallbackQuery(callbackQuery.id);

  if (!taskId) {
    throw new Error('Missing task ID');
  }

  const unansweredLogs = await socraticQueries.getUnansweredLogs(user.id);

  if (unansweredLogs.length > 0) {
    const log = unansweredLogs[0];

    const logAge =
      Date.now() - new Date(log.created_at).getTime();

    const tenMinutes = 10 * 60 * 1000;

    if (logAge < tenMinutes) {
      await this.bot.sendMessage(
        chatId,
        `🤔 *Answer first!*\n\n"${log.question}"`,
        { parse_mode: 'Markdown' }
      );

      return;
    }

    await socraticQueries.clearAwaitingResponse(user.id);
  }

  const result =
    await taskService.handleTaskComplete(user.id, taskId);

  if (result.alreadyCompleted) {
    return;
  }

  await this.bot.editMessageReplyMarkup(
    {
      inline_keyboard: [
        [
          {
            text: '✅ Completed',
            callback_data: 'task:completed',
          },
        ],
      ],
    },
    {
      chat_id: chatId,
      message_id: messageId,
    }
  );

  const today = new Date()
    .toISOString()
    .split('T')[0];

  const remaining =
    await taskQueries.countIncompleteTasks(user.id, today);

  const allDone = remaining === 0;

  if (allDone) {
    await userQueries.updateStreak(user.id, true);
  }

  const updatedUser =
    await userQueries.getUserByTelegramId(user.telegram_id);

  const tone =
    personalityService.getPersonalityTone(
      updatedUser.personality_type
    );

  await this.bot.sendMessage(
    chatId,
    tone.completion.positive
  );

  await this._maybeAskProgressiveQuestion(
    chatId,
    updatedUser
  );
}

  // FIX 7: Atomic progressive question guard
  async _maybeAskProgressiveQuestion(chatId, user) {
    try {
      const step = user.progressive_onboarding_step || 0;
      const today = new Date().toISOString().split('T')[0];

      // FIX 7: Atomic DB guard — only one callback can acquire
      const acquired = await userQueries.trySetProgressiveQuestionDate(
        user.telegram_id,
        today
      );

      if (!acquired) return;

      if (step === 0 && !user.biggest_struggle) {
        await this.bot.sendMessage(
          chatId,
          "👋 Quick question while you're on a roll —\n\n" +
          "*What's your biggest challenge when it comes to staying consistent?*\n\n" +
          "Maybe it's procrastination, getting overwhelmed, or losing momentum after a few days. " +
          "Knowing this helps me spot the pattern early and adapt before it derails you.",
          { parse_mode: 'Markdown' }
        );
        await userQueries.incrementProgressiveStep(user.telegram_id);
        return;
      }

      if (step === 1 && !user.domain_knowledge) {
        await this.bot.sendMessage(
          chatId,
          "🎯 One more quick thing —\n\n" +
          "*What's your current experience level in the area your goal is in?*\n\n" +
          "For example: 'I've done Python basics but never built a real project' " +
          "or 'I'm completely new to this.' This helps me set the right difficulty.",
          { parse_mode: 'Markdown' }
        );
        await userQueries.incrementProgressiveStep(user.telegram_id);
        return;
      }

      if (step === 2 && !user.motivation) {
        await this.bot.sendMessage(
          chatId,
          "🌟 You've been showing up consistently — respect.\n\n" +
          "*What's the deeper reason behind your goal?*\n\n" +
          "Not the surface answer — the real one. " +
          "What will achieving this make possible in your life? " +
          "When things get hard, this is what I'll remind you of.",
          { parse_mode: 'Markdown' }
        );
        await userQueries.incrementProgressiveStep(user.telegram_id);
        return;
      }

    } catch (err) {
      logger.error(`Progressive question error for ${user.telegram_id}:`, err);
    }
  }

  // FIX 13: Uses isLowInformationAnswer instead of raw length checks
  async handleProgressiveAnswer(chatId, telegramId, text, user) {
    const step = user.progressive_onboarding_step || 0;

    try {
      if (step === 1 && !user.biggest_struggle) {
        if (isLowInformationAnswer(text)) {
          await this.bot.sendMessage(chatId, 'Could you elaborate a little more on your struggle?');
          return true;
        }

        await userQueries.saveProgressiveAnswer(telegramId, 'biggest_struggle', text.trim());
        const freshUser = await userQueries.getUserByTelegramId(telegramId);

        const reply = await this._getProgressiveAIReply(
          freshUser.goal,
          'biggest_struggle',
          text.trim()
        );
        await this.bot.sendMessage(chatId, reply);
        return true;
      }

      if (step === 2 && !user.domain_knowledge) {
        if (isLowInformationAnswer(text)) {
          await this.bot.sendMessage(chatId, 'A couple of sentences would help — just your background and experience level.');
          return true;
        }

        await userQueries.saveProgressiveAnswer(telegramId, 'domain_knowledge', text.trim());
        const freshUser = await userQueries.getUserByTelegramId(telegramId);

        const reply = await this._getProgressiveAIReply(
          freshUser.goal,
          'domain_knowledge',
          text.trim()
        );
        await this.bot.sendMessage(chatId, reply);
        return true;
      }

      if (step === 3 && !user.motivation) {
        if (isLowInformationAnswer(text)) {
          await this.bot.sendMessage(chatId, 'Take a moment to think about it. Write a bit more.');
          return true;
        }

        await userQueries.saveProgressiveAnswer(telegramId, 'motivation', text.trim());
        const freshUser = await userQueries.getUserByTelegramId(telegramId);

        const reply = await this._getProgressiveAIReply(
          freshUser.goal,
          'motivation',
          text.trim()
        );
        await this.bot.sendMessage(chatId, reply);
        return true;
      }

    } catch (err) {
      logger.error(`Failed saving progressive answer for ${telegramId}:`, err);
    }

    return false;
  }

  async _getProgressiveAIReply(goal, field, userAnswer) {
    const prompts = {
      biggest_struggle: `The user is working toward: "${goal}".
They just told you their biggest consistency challenge: "${userAnswer}"
Reply in 2 sentences max. Acknowledge what they specifically said, then give ONE concrete tip to handle it.
No cheerleading. No "I understand". Be direct and specific.`,

      domain_knowledge: `The user is working toward: "${goal}".
They just described their experience level: "${userAnswer}"
Reply in 1-2 sentences. Confirm you understood their level and tell them specifically how you'll adjust their tasks.
Be concrete — e.g. "Since you're new to X, I'll start with fundamentals before moving to Y."`,

      motivation: `The user is working toward: "${goal}".
They just shared their deeper motivation: "${userAnswer}"
Reply in 2 sentences max. Reflect back what they said in your own words and tell them you'll use this when things get hard.
No fluff. Make it feel like you actually read what they wrote.`,
    };

    try {
      const messages = [
        { role: 'system', content: prompts[field] }
      ];
      const reply = await aiOrchestrator.execute(messages, { temperature: 0.7, maxTokens: 100 });
      return reply.trim();
    } catch (err) {
      const fallbacks = {
        biggest_struggle: "Got it — I'll watch for that pattern and adapt before it derails you.",
        domain_knowledge: "Perfect — I'll calibrate task difficulty based on your level.",
        motivation:       "That's what I'll remind you of when things get hard.",
      };
      return fallbacks[field];
    }
  }

async handleSkipRequest(callbackQuery, taskId) {
  const { chatId, messageId } =
    await this._getCallbackContext(callbackQuery);

  await this.bot.editMessageText(
    'Why are you skipping this task?',
    {
      chat_id: chatId,
      message_id: messageId,
      ...inlineKeyboards.skipReasons(taskId),
    }
  );
}


async handleSkipReason(callbackQuery, taskId, reason) {
  const { chatId, messageId, user } =
    await this._getCallbackContext(callbackQuery);

  await this.bot.answerCallbackQuery(callbackQuery.id);

  await taskService.handleTaskSkip(
    user.id,
    taskId,
    reason
  );

  const messages = {
    no_time:
      '⏰ Noted. Time constraints detected.',
    too_difficult:
      '📚 Difficulty adjustment noted.',
    not_relevant:
      '🎯 Relevance feedback recorded.',
    lost_motivation:
      '⚡ Motivation drop recorded.',
    personal_emergency:
      '🚨 Emergency acknowledged.',
  };

  await this.bot.editMessageText(
    messages[reason] || 'Task skipped.',
    {
      chat_id: chatId,
      message_id: messageId,
    }
  );
}


async handleTooHard(callbackQuery, taskId) {
  const { chatId, messageId, user } =
    await this._getCallbackContext(callbackQuery);

  await this.bot.answerCallbackQuery(callbackQuery.id);

  const result =
    await taskService.handleTaskTooHard(
      user.id,
      taskId
    );

  const message =
    personalityService.adaptDifficultyMessage(
      user.personality_type,
      true
    );

  await this.bot.editMessageText(
    `${message}\n\n*Simplified Task:*\n${result.simplified.title}`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      ...inlineKeyboards.taskActions(
        result.simplified.id
      ),
    }
  );
}


async handleSocraticPrompt(
  callbackQuery,
  taskId
) {

  const { chatId, messageId } =
    await this._getCallbackContext(
      callbackQuery
    );

  await this.bot.answerCallbackQuery(
    callbackQuery.id
  );

  await this.bot.editMessageText(
    'Please type your answer below.',
    {
      chat_id: chatId,
      message_id: messageId,
    }
  );
}


async handleSkipSocratic(
  callbackQuery
) {

  const { chatId, messageId } =
    await this._getCallbackContext(
      callbackQuery
    );

  await this.bot.editMessageText(
    'No problem. Moving on.',
    {
      chat_id: chatId,
      message_id: messageId,
    }
  );
}


  async showProgress(chatId, messageId, user) {
    const progress = await taskService.getTodayProgress(user.id);
    
    const progressBar = this.generateProgressBar(progress.percentage);
    
    await this.bot.editMessageText(
      `📊 *Today's Progress*\n\n` +
      `${progressBar} ${progress.percentage}%\n\n` +
      `✅ Completed: ${progress.completed}/${progress.total}\n` +
      `⏰ Remaining: ${progress.remaining}\n` +
      `🔥 Streak: ${user.current_streak} days`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...inlineKeyboards.mainMenu(),
      }
    );
  }

  async showStats(chatId, messageId, user) {
    await this.bot.editMessageText(
      `📈 *Your Stats*\n\n` +
      `🎯 Goal: ${user.goal}\n` +
      `📅 Deadline: ${user.deadline}\n` +
      `⏰ Daily Time: ${user.available_time}\n` +
      `🔥 Current Streak: ${user.current_streak} days\n` +
      `👑 Best Streak: ${user.longest_streak} days\n` +
      `🗓 Active Since: ${dateUtils.formatDate(user.created_at)}\n` +
      `🧠 Personality: ${user.personality_type}`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...inlineKeyboards.mainMenu(),
      }
    );
  }

  async showGoal(chatId, messageId, user) {
    await this.bot.editMessageText(
      `🎯 *Your Goal*\n\n` +
      `*What:* ${user.goal}\n` +
      `*By when:* ${user.deadline}\n` +
      `*Daily time:* ${user.available_time}\n\n` +
      `*Why it matters:*\n${user.motivation}\n\n` +
      `*Current challenge:*\n${user.biggest_struggle}`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...inlineKeyboards.mainMenu(),
      }
    );
  }

  async showHelp(chatId, messageId) {
    await this.bot.editMessageText(
      '🤖 *ATLAS Commands*\n\n' +
      '/start - View today\'s tasks\n' +
      '/today - Check today\'s missions\n' +
      '/progress - Your daily progress\n' +
      '/stats - Your statistics\n' +
      '/review - Weekly performance review\n' +
      '/goal - Your goal details\n' +
      '/help - This help message\n\n' +
      '*How it works:*\n' +
      '• Tasks arrive at your scheduled time daily\n' +
      '• Tap Done, Skip, or Too Hard\n' +
      '• Get understanding questions\n' +
      '• Weekly reviews on Sundays\n' +
      '• Adaptive based on your patterns',
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...inlineKeyboards.mainMenu(),
      }
    );
  }

  async showReview(chatId, messageId, user) {
    const review = await reviewService.getLatestReview(user.id);
    
    if (!review) {
      await this.bot.editMessageText(
        'No weekly review available yet. Complete a full week of tasks first!',
        {
          chat_id: chatId,
          message_id: messageId,
          ...inlineKeyboards.mainMenu(),
        }
      );
      return;
    }

    const formattedReview = await reviewService.formatReviewMessage(review);
    
    await this.bot.editMessageText(
      formattedReview,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...inlineKeyboards.mainMenu(),
      }
    );
  }

async handleStuckResponse(
  callbackQuery,
  reason
) {

  const { chatId, messageId, user } =
    await this._getCallbackContext(
      callbackQuery
    );

  const isTechnical =
    reason === 'technical' ||
    reason === 'overwhelmed';

  const message =
    personalityService.getStuckMessage(
      user.personality_type,
      isTechnical
    );

  await this.bot.editMessageText(
    `${message}\n\nI've noted this and will adapt future tasks.`,
    {
      chat_id: chatId,
      message_id: messageId,
    }
  );

  await checkinQueries.createCheckin(
    user.id,
    {
      type: 'stuck',
      response: reason,
    }
  );
}


  
  async handleResetConfirm(chatId, messageId, user) {
    try {
      await this.bot.editMessageText(
        '⏳ Resetting your ATLAS profile...',
        { chat_id: chatId, message_id: messageId }
      );
      await taskQueries.deleteUserTasks(user.id);
      await checkinQueries.deleteUserCheckins(user.id);
      await socraticQueries.deleteUserLogs(user.id);
      await reviewQueries.deleteUserReviews(user.id);
      await memoryQueries.deleteUserMemory(user.id);
      await userQueries.resetUser(user.id);
      await this.bot.editMessageText(
        '✅ Profile reset! Type /start to begin again.',
        { chat_id: chatId, message_id: messageId }
      );
      logger.info(`User ${user.telegram_id} reset successfully`);
    } catch (error) {
      logger.error(`Reset failed for ${user.telegram_id}:`, error);
      await this.bot.editMessageText(
        '❌ Reset failed. Try again.',
        { chat_id: chatId, message_id: messageId }
      );
    }
  }

  async handleResetCancel(chatId, messageId) {
    await this.bot.editMessageText(
      '❌ Reset cancelled. Your profile is safe.',
      { chat_id: chatId, message_id: messageId }
    );
  }
  
  generateProgressBar(percentage) {
    const filled = Math.max(0, Math.min(10, Math.round(percentage / 10)));
    const empty = 10 - filled;
    return '🟩'.repeat(filled) + '⬜'.repeat(empty);
  }

  async handleMorningPrefAi(chatId, messageId, user, telegramId) {
    try {
      const { supabase } = require('../../config/supabase');
      const today = new Date().toISOString().split('T')[0];

      await supabase
        .from('users')
        .update({
          daily_task_preference: 'ai',
          daily_task_preference_date: today,
        })
        .eq('telegram_id', telegramId);

      await this.bot.editMessageText(
        '🤖 Got it! Generating your tasks now...',
        { chat_id: chatId, message_id: messageId }
      );

      await dailyCron.sendTasksImmediately(telegramId);
    } catch (error) {
      logger.error(`morning_pref_ai failed for ${telegramId}:`, error);
      await this.bot.editMessageText(
        '❌ Failed to generate tasks. Try saying "generate tasks".',
        { chat_id: chatId, message_id: messageId }
      );
    }
  }

  async handleMorningPrefManual(chatId, messageId, user, telegramId) {
    try {
      const { supabase } = require('../../config/supabase');
      const today = new Date().toISOString().split('T')[0];

      await supabase
        .from('users')
        .update({
          daily_task_preference: 'manual',
          daily_task_preference_date: today,
        })
        .eq('telegram_id', telegramId);

      await this.bot.editMessageText(
        `✅ Got it! Add your tasks anytime:\n\nJust say:\n*Add tasks*\n1. Your first task\n2. Your second task\n3. Your third task`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
      );
    } catch (error) {
      logger.error(`morning_pref_manual failed for ${telegramId}:`, error);
    }
  }

  async handleRoadmapMenu(callbackQuery) {

  const { chatId, messageId } =
    await this._getCallbackContext(
      callbackQuery
    );

  await this.bot.editMessageText(
    '🗺️ *Your Roadmap*\n\nWhat would you like to see?',
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      ...inlineKeyboards.roadmapMenu(),
    }
  );
}


async handleRoadmapFull(callbackQuery) {
  const { chatId, messageId, user } =
    await this._getCallbackContext(callbackQuery);

  const freshUser =
    await userQueries.getUserByTelegramId(
      user.telegram_id
    );

  if (!freshUser?.roadmap) {
    await this.bot.editMessageText(
      'No roadmap found.',
      {
        chat_id: chatId,
        message_id: messageId,
      }
    );

    return;
  }

  await this.bot.editMessageText(
    freshUser.roadmap,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      ...inlineKeyboards.mainMenu(),
    }
  );
}



async handleRoadmapPhase(callbackQuery) {
  const { chatId, messageId, user } =
    await this._getCallbackContext(callbackQuery);

  const freshUser =
    await userQueries.getUserByTelegramId(
      user.telegram_id
    );

  let roadmapJson = freshUser?.roadmap_json;

  if (typeof roadmapJson === 'string') {
    roadmapJson = JSON.parse(roadmapJson);
  }

if (
  !roadmapJson ||
  !roadmapJson.phases
) {

  await this.bot.editMessageText(
    'No roadmap phases found.',
    {
      chat_id: chatId,
      message_id: messageId,
    }
  );

  return;
}


  const currentIndex =
    roadmapJson.current_phase_index || 1;

  const phase =
    roadmapJson.phases.find(
      p => p.phase_index === currentIndex
    );
if (!phase) {

  await this.bot.editMessageText(
    'Current roadmap phase not found.',
    {
      chat_id: chatId,
      message_id: messageId,
    }
  );

  return;
}


  await this.bot.editMessageText(
    `📍 *Current Phase: ${phase.phase_name}*`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      ...inlineKeyboards.mainMenu(),
    }
  );
}


async handleRoadmapWeekly(
  callbackQuery
) {

  const { chatId, messageId, user } =
    await this._getCallbackContext(
      callbackQuery
    );

  try {

    if (
      !user ||
      !user.roadmap_json ||
      !user.roadmap_json.phases
    ) {
      await this.bot.editMessageText(
        'No roadmap found yet.',
        {
          chat_id: chatId,
          message_id: messageId,
        }
      );

      return;
    }

    const roadmapJson = user.roadmap_json;

    const prompt = `
Convert this roadmap into a practical weekly execution plan.

${JSON.stringify(
  roadmapJson.phases,
  null,
  2
)}
`;

    const weeklyPlan =
      await aiOrchestrator.execute(
        [
          {
            role: 'system',
            content: prompt,
          },
        ],
        {
          temperature: 0.4,
          maxTokens: 800,
        }
      );

    await this.bot.editMessageText(
      weeklyPlan,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
      }
    );

  } catch (err) {

    logger.error(
      'handleRoadmapWeekly failed:',
      err
    );

    await this.bot.editMessageText(
      'Failed generating weekly breakdown.',
      {
        chat_id: chatId,
        message_id: messageId,
      }
    );
  }
}

}

module.exports = CallbackHandler;