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
const telegramClient = require('../../utils/telegram/telegramClient');

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

  const data = callbackQuery.data || '';

  // Dedup: Telegram redelivers callback queries on slow handlers; the TTL
  // map existed but was never populated, so double-taps double-executed.
  if (callbackQuery.id) {
    if (this.processedCallbacks.has(callbackQuery.id)) return;
    this.processedCallbacks.set(callbackQuery.id, { timestamp: Date.now() });
  }

  try {

    // ALWAYS answer callback immediately
    await telegramClient.answerCallbackQuery(
      this.bot,
      callbackQuery.id
    );

    // =====================================================
    // GLOBAL NON-ROUTER CALLBACKS
    // =====================================================

    if (data === 'reset_confirm') {

      const {
        chatId,
        messageId,
        user,
      } = await this._getCallbackContext(
        callbackQuery
      );

      return this.handleResetConfirm(
        chatId,
        messageId,
        user
      );
    }

     if (data === 'pending:skipall' || data === 'pending:keep') {
      const { chatId, messageId, user } = await this._getCallbackContext(callbackQuery);
      return this.handlePendingDecision(chatId, messageId, user, data);
    }

     if (data === 'pending:addkeep' || data === 'pending:addskip') {
      const { chatId, messageId, user } = await this._getCallbackContext(callbackQuery);
      return this.handleAppendDecision(chatId, messageId, user, data);
    }

    if (data === 'morning_pref_ai' || data === 'morning_pref_manual') {
      const { chatId, messageId, user } = await this._getCallbackContext(callbackQuery);
      return data === 'morning_pref_ai'
        ? this.handleMorningPrefAi(chatId, messageId, user, user.telegram_id)
        : this.handleMorningPrefManual(chatId, messageId, user, user.telegram_id);
    }

    if (data === 'reset_cancel') {

      const {
        chatId,
        messageId,
      } = await this._getCallbackContext(
        callbackQuery
      );

      return this.handleResetCancel(
        chatId,
        messageId
      );
    }

    // =====================================================
    // ROUTER CALLBACKS
    // =====================================================
    // =====================================================
// ONBOARDING CALLBACKS
// =====================================================
// =====================================================
// CHANGE TIME CALLBACKS (post-onboarding settings)
// =====================================================
if (data.startsWith('changetime_')) {
  const time = data.replace('changetime_', '');
  return this.handleChangeTimeConfirm(callbackQuery, time);
}


const onboardingPrefixes = [
  'onboarding_',
  'knowledge_',
  'struggle_',
  'time_',
  'tz_',
  'startdate_',
  'taskmode_',
  'finalmode_',
  'roadmap_weekly_',
];

const isOnboardingCallback =
  onboardingPrefixes.some(prefix =>
    data.startsWith(prefix)
  );

if (
  isOnboardingCallback &&
  this.onboardingFlow
) {
  return this.onboardingFlow.handleCallback(
    callbackQuery
  );
}

    await callbackRouter.route(
      callbackQuery,
      this
    );

  } catch (error) {

    logger.error(
      'Callback error:',
      error
    );

    try {

      await telegramClient.answerCallbackQuery(
        this.bot,
        callbackQuery.id,
        'Something went wrong.',
        false
      );

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

    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
      '✏️ Please reply with your preferred time.'
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

    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
      `✅ Time updated to *${safeTime}*`,
      { parse_mode: 'MarkdownV2' }
    );

  } catch (error) {

    logger.error(
      `Change time failed for ${user.telegram_id}:`,
      error
    );

    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
      '❌ Failed to update time.'
    );
  }
}

// (Dead handlers removed: _handleMenuAction, handleTasksNow, handleTasksScheduled,
// handleDeleteCancel, handleDeleteConfirm — no callback ever routed to them.
// Menu actions route through callbacks/menuCallbacks.js; deletion flows through
// the ownership-scoped executors; handleDeleteConfirm additionally hard-deleted
// tasks WITHOUT an ownership check.)

  // FIX 5: answerCallbackQuery moved to START
async handleDone(callbackQuery, taskId) {
  const { chatId, messageId, user } =
    await this._getCallbackContext(callbackQuery);

  await telegramClient.answerCallbackQuery(this.bot, callbackQuery.id);

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
      await telegramClient.sendMessage(
        this.bot,
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

  await telegramClient.editMessageReplyMarkup(
    this.bot,
    chatId,
    messageId,
    {
      inline_keyboard: [
        [{ text: '✅ Completed', callback_data: 'task:completed' }],
      ],
    }
  );

  

  const updatedUser =
    await userQueries.getUserByTelegramId(user.telegram_id);

  const tone =
    personalityService.getPersonalityTone(
      updatedUser.personality_type
    );

  await telegramClient.sendMessage(
    this.bot,
    chatId,
    tone.completion.positive
  );

  // Understanding check: taskService says whether this user is due a
  // socratic question — generate one and attach the Answer/Skip keyboard.
  // (This was computed but ignored, so the whole socratic loop never started.)
  if (result.shouldAskSocratic) {
    try {
      const question = await socraticEvaluator.generateQuestion(taskId, user.id);
      if (question) {
        await socraticQueries.createLog({
          userId: user.id,
          taskId,
          question,
        });
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          `🤔 *Quick check:*\n\n${question}`,
          { parse_mode: 'Markdown', ...inlineKeyboards.socraticPrompt(taskId) }
        );
      }
    } catch (err) {
      logger.error(`Socratic question failed for ${user.telegram_id} (task ${taskId}):`, err);
    }
  }

  await this._maybeAskProgressiveQuestion(
    chatId,
    updatedUser
  );
}

  // FIX 7: Atomic progressive question guard
  async _maybeAskProgressiveQuestion(chatId, user) {
    try {
      // Pick the question by which profile field is actually missing —
      // gating on step numbers stalled forever because main onboarding
      // pre-fills biggest_struggle, so step 0 could never fire and
      // motivation was never collected.
      let question = null;
      let nextStep = null;

      if (!user.biggest_struggle) {
        nextStep = 1;
        question =
          "👋 Quick question while you're on a roll —\n\n" +
          "*What's your biggest challenge when it comes to staying consistent?*\n\n" +
          "Maybe it's procrastination, getting overwhelmed, or losing momentum after a few days. " +
          "Knowing this helps me spot the pattern early and adapt before it derails you.";
      } else if (!user.domain_knowledge) {
        nextStep = 2;
        question =
          "🎯 One more quick thing —\n\n" +
          "*What's your current experience level in the area your goal is in?*\n\n" +
          "For example: 'I've done Python basics but never built a real project' " +
          "or 'I'm completely new to this.' This helps me set the right difficulty.";
      } else if (!user.motivation) {
        nextStep = 3;
        question =
          "🌟 You've been showing up consistently — respect.\n\n" +
          "*What's the deeper reason behind your goal?*\n\n" +
          "Not the surface answer — the real one. " +
          "What will achieving this make possible in your life? " +
          "When things get hard, this is what I'll remind you of.";
      }

      if (!question) return; // profile complete — don't burn the daily slot

      const today = new Date().toISOString().split('T')[0];

      // FIX 7: Atomic DB guard — only one callback can acquire per day
      const acquired = await userQueries.trySetProgressiveQuestionDate(
        user.telegram_id,
        today
      );
      if (!acquired) return;

      await telegramClient.sendMessage(this.bot, chatId, question, {
        parse_mode: 'Markdown',
      });
      // Step tells handleProgressiveAnswer which field the next reply fills.
      await userQueries.setProgressiveStep(user.telegram_id, nextStep);
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
          await telegramClient.sendMessage(this.bot, chatId, 'Could you elaborate a little more on your struggle?');
          return true;
        }

        await userQueries.saveProgressiveAnswer(telegramId, 'biggest_struggle', text.trim());
        const freshUser = await userQueries.getUserByTelegramId(telegramId);

        const reply = await this._getProgressiveAIReply(
          freshUser.goal,
          'biggest_struggle',
          text.trim()
        );
        await telegramClient.sendMessage(this.bot, chatId, reply);
        return true;
      }

      if (step === 2 && !user.domain_knowledge) {
        if (isLowInformationAnswer(text)) {
          await telegramClient.sendMessage(this.bot, chatId, 'A couple of sentences would help — just your background and experience level.');
          return true;
        }

        await userQueries.saveProgressiveAnswer(telegramId, 'domain_knowledge', text.trim());
        const freshUser = await userQueries.getUserByTelegramId(telegramId);

        const reply = await this._getProgressiveAIReply(
          freshUser.goal,
          'domain_knowledge',
          text.trim()
        );
        await telegramClient.sendMessage(this.bot, chatId, reply);
        return true;
      }

      if (step === 3 && !user.motivation) {
        if (isLowInformationAnswer(text)) {
          await telegramClient.sendMessage(this.bot, chatId, 'Take a moment to think about it. Write a bit more.');
          return true;
        }

        await userQueries.saveProgressiveAnswer(telegramId, 'motivation', text.trim());
        const freshUser = await userQueries.getUserByTelegramId(telegramId);

        const reply = await this._getProgressiveAIReply(
          freshUser.goal,
          'motivation',
          text.trim()
        );
        await telegramClient.sendMessage(this.bot, chatId, reply);
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

  const keyboard = inlineKeyboards.skipReasons(taskId);

  await telegramClient.editMessage(
    this.bot,
    chatId,
    messageId,
    'Why are you skipping this task?',
    { reply_markup: keyboard.reply_markup }
  );
}


async handleSkipReason(callbackQuery, taskId, reason) {
  const { chatId, messageId, user } =
    await this._getCallbackContext(callbackQuery);

  // Decode short reason codes (long forms still accepted for old messages)
  const reasonMap = {
    nt: 'no_time',
    td: 'too_difficult',
    nr: 'not_relevant',
    lm: 'lost_motivation',
    pe: 'personal_emergency',
  };
  reason = reasonMap[reason] || reason;

  await telegramClient.answerCallbackQuery(this.bot, callbackQuery.id);

  await taskService.handleTaskSkip(user.id, taskId, reason);

  const messages = {
    no_time:
      "⏰ No worries — some days are just packed. I'll factor this in for tomorrow.",
    too_difficult:
      "📚 Got it. I'll dial down the difficulty on upcoming tasks.",
    not_relevant:
      "❌ Noted — I'll adjust your upcoming tasks to stay closer to your goal.",
    lost_motivation:
      "😔 That's okay. Showing up at all matters. Tomorrow is a fresh start.",
    personal_emergency:
      '🚨 Take care of what matters. Your tasks will be here when you\'re ready.',
  };

  await telegramClient.editMessage(
    this.bot,
    chatId,
    messageId,
    messages[reason] || 'Task skipped. Noted for tomorrow.'
  );
}


async handleTooHard(callbackQuery, taskId) {
  const { chatId, messageId, user } =
    await this._getCallbackContext(callbackQuery);

  await telegramClient.answerCallbackQuery(this.bot, callbackQuery.id);

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

  await telegramClient.editMessage(
    this.bot,
    chatId,
    messageId,
    `${message}\n\n*Simplified Task:*\n${result.simplified.title}`,
    {
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

  await telegramClient.answerCallbackQuery(
    this.bot,
    callbackQuery.id
  );

  await telegramClient.editMessage(
    this.bot,
    chatId,
    messageId,
    'Please type your answer below.'
  );
}


async handleSkipSocratic(
  callbackQuery
) {

  const { chatId, messageId, user } =
    await this._getCallbackContext(
      callbackQuery
    );

  // Clear the awaiting log so the user's next message isn't swallowed
  // as a socratic answer.
  await socraticQueries.clearAwaitingResponse(user.id);

  await telegramClient.editMessage(
    this.bot,
    chatId,
    messageId,
    'No problem. Moving on.'
  );
}


  async showProgress(chatId, messageId, user) {
    const progress = await taskService.getTodayProgress(user.id);
    
    const progressBar = this.generateProgressBar(progress.percentage);
    
    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
      `📊 *Today's Progress*\n\n` +
      `${progressBar} ${progress.percentage}%\n\n` +
      `✅ Completed: ${progress.completed}/${progress.total}\n` +
      `⏰ Remaining: ${progress.remaining}\n` +
      `🔥 Streak: ${user.current_streak} days`,
      {
        parse_mode: 'Markdown',
        ...inlineKeyboards.mainMenu(),
      }
    );
  }

  async showStats(chatId, messageId, user) {
    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
      `📈 *Your Stats*\n\n` +
      `🎯 Goal: ${user.goal || 'Not set — type /start'}\n` +
      (user.deadline ? `📅 Deadline: ${user.deadline}\n` : '') +
      `⏰ Daily Time: ${user.available_time || 'Not set'}\n` +
      `🔥 Current Streak: ${user.current_streak} days\n` +
      `👑 Best Streak: ${user.longest_streak} days\n` +
      `🗓 Active Since: ${dateUtils.formatDate(user.created_at)}\n` +
      (user.personality_type ? `🧠 Personality: ${user.personality_type}` : ''),
      {
        parse_mode: 'Markdown',
        ...inlineKeyboards.mainMenu(),
      }
    );
  }

  async showGoal(chatId, messageId, user) {
    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
      `🎯 *Your Goal*\n\n` +
      `*What:* ${user.goal || 'Not set — type /start'}\n` +
      (user.deadline ? `*By when:* ${user.deadline}\n` : '') +
      `*Daily time:* ${user.available_time || 'Not set'}\n\n` +
      (user.motivation ? `*Why it matters:*\n${user.motivation}\n\n` : '') +
      (user.biggest_struggle ? `*Current challenge:*\n${user.biggest_struggle}` : ''),
      {
        parse_mode: 'Markdown',
        ...inlineKeyboards.mainMenu(),
      }
    );
  }

  async showHelp(chatId, messageId) {
    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
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
        parse_mode: 'Markdown',
        ...inlineKeyboards.mainMenu(),
      }
    );
  }

  async showReview(chatId, messageId, user) {
    const review = await reviewService.getLatestReview(user.id);
    
    if (!review) {
      await telegramClient.editMessage(
        this.bot,
        chatId,
        messageId,
        'No weekly review available yet. Complete a full week of tasks first!',
        inlineKeyboards.mainMenu()
      );
      return;
    }

    const formattedReview = await reviewService.formatReviewMessage(review);
    
    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
      formattedReview,
      {
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

  await telegramClient.editMessage(
    this.bot,
    chatId,
    messageId,
    `${message}\n\nI've noted this and will adapt future tasks.`
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
      await telegramClient.editMessage(
        this.bot,
        chatId,
        messageId,
        '⏳ Resetting your ATLAS profile...'
      );
      await taskQueries.deleteUserTasks(user.id);
      await checkinQueries.deleteUserCheckins(user.id);
      await socraticQueries.deleteUserLogs(user.id);
      await reviewQueries.deleteUserReviews(user.id);
      await memoryQueries.deleteUserMemory(user.id);
      await userQueries.resetUser(user.id);
      await telegramClient.editMessage(
        this.bot,
        chatId,
        messageId,
        '✅ Profile reset! Type /start to begin again.'
      );
      logger.info(`User ${user.telegram_id} reset successfully`);
    } catch (error) {
      logger.error(`Reset failed for ${user.telegram_id}:`, error);
      await telegramClient.editMessage(
        this.bot,
        chatId,
        messageId,
        '❌ Reset failed. Try again.'
      );
    }
  }

   async handlePendingDecision(chatId, messageId, user, data) {
    const stateManager = require('../../core/state/stateManager');
    // Read the stored request BEFORE clearing so we preserve any details
    // (e.g. a time constraint) the user attached to the original ask.
    const pending = stateManager.getContext(user.telegram_id);
    const userTz = user.timezone || 'UTC';
    const today = timezoneUtils.getCurrentTimeInZone(userTz).toISOString().split('T')[0];

    if (data !== 'pending:skipall') {
      // pending:keep — leave everything as-is, user finishes them first.
      stateManager.clearContext(user.telegram_id);
      await telegramClient.editMessage(
        this.bot,
        chatId,
        messageId,
        "📌 Got it — finish your previous tasks first. Mark them ✅ Done, then ask me for new tasks."
      );
      return;
    }

    // Skip: deactivate the old tasks (neutral to streak) and regenerate through
    // the SAME executor used for on-demand generation. Using it instead of
    // dailyCron.sendTasksImmediately avoids the morning-delivery ceremony —
    // the "Good Morning" banner and re-listing the very tasks we just skipped.
    await taskQueries.clearPendingForRegeneration(user.id, today);
    stateManager.clearContext(user.telegram_id);
    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
      '⏭️ Old tasks skipped. Generating fresh tasks...'
    );
    await this._regenerateAfterDecision(user, pending);
  }

  // Shared regeneration used by both keep/skip decision handlers. Runs the
  // conversational generate path directly (gate already answered) and sends the
  // resulting task list — no morning banner, no re-listing of old tasks.
  async _regenerateAfterDecision(user, pending) {
    const contextBuilder = require('../../core/context/contextBuilder');
    const generateTasksExecutor = require('../../core/execution/executors/generateTasksExecutor');
    const ACTIONS = require('../../core/actions/actionTypes');

    try {
      const context = await contextBuilder.build(user.telegram_id, '');
      if (!context) {
        await telegramClient.sendMessage(this.bot, user.telegram_id, '😅 Something went wrong. Try again.');
        return;
      }
      const plan = {
        intent: ACTIONS.GENERATE_TASKS,
        payload: (pending && pending.payload) ? pending.payload : {},
        _skipPendingGate: true,
      };
      const result = await generateTasksExecutor.execute(plan, context);
      await telegramClient.sendMessage(
        this.bot,
        user.telegram_id,
        result.message,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      logger.error(`_regenerateAfterDecision failed for ${user.telegram_id}:`, error);
      await telegramClient.sendMessage(this.bot, user.telegram_id, '😅 Something went wrong generating tasks. Try again.');
    }
  }

  // Handles the "add topic tasks on top of unfinished work" decision. Unlike the
  // replace path, this regenerates through the executor so the originally
  // requested topic (stored in stateManager) is preserved.
  async handleAppendDecision(chatId, messageId, user, data) {
    const stateManager = require('../../core/state/stateManager');
    const pending = stateManager.getContext(user.telegram_id);
    if (!pending) {
      await telegramClient.editMessage(
        this.bot,
        chatId,
        messageId,
        '⌛ That request expired. Just ask me for the tasks again.'
      );
      return;
    }

    const userTz = user.timezone || 'UTC';
    const today = timezoneUtils.getCurrentTimeInZone(userTz).toISOString().split('T')[0];

    if (data === 'pending:addskip') {
      await taskQueries.clearPendingForRegeneration(user.id, today);
    }
    stateManager.clearContext(user.telegram_id);

    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
      data === 'pending:addskip'
        ? '⏭️ Skipped your unfinished tasks. Adding the new ones...'
        : '➕ Keeping your unfinished tasks. Adding the new ones on top...'
    );

    await this._regenerateAfterDecision(user, pending);
  }

  async handleResetCancel(chatId, messageId) {
    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
      '❌ Reset cancelled. Your profile is safe.'
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

      await telegramClient.editMessage(
        this.bot,
        chatId,
        messageId,
        '🤖 Got it! Generating your tasks now...'
      );

      await dailyCron.sendTasksImmediately(telegramId);
    } catch (error) {
      logger.error(`morning_pref_ai failed for ${telegramId}:`, error);
      await telegramClient.editMessage(
        this.bot,
        chatId,
        messageId,
        '❌ Failed to generate tasks. Try saying "generate tasks".'
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

      await telegramClient.editMessage(
        this.bot,
        chatId,
        messageId,
        `✅ Got it! Add your tasks anytime:\n\nJust say:\n*Add tasks*\n1. Your first task\n2. Your second task\n3. Your third task`,
        { parse_mode: 'Markdown' }
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

  await telegramClient.editMessage(
    this.bot,
    chatId,
    messageId,
    '🗺️ *Your Roadmap*\n\nWhat would you like to see?',
    {
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
    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
      'No roadmap found.'
    );

    return;
  }

  await telegramClient.editMessage(
    this.bot,
    chatId,
    messageId,
    freshUser.roadmap,
    {
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

  await telegramClient.editMessage(
    this.bot,
    chatId,
    messageId,
    'No roadmap phases found.'
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

  await telegramClient.editMessage(
    this.bot,
    chatId,
    messageId,
    'Current roadmap phase not found.'
  );

  return;
}


  await telegramClient.editMessage(
    this.bot,
    chatId,
    messageId,
    `📍 *Current Phase: ${phase.phase_name}*`,
    {
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
      await telegramClient.editMessage(
        this.bot,
        chatId,
        messageId,
        'No roadmap found yet.'
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

    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
      weeklyPlan,
      {
        parse_mode: 'Markdown',
      }
    );

  } catch (err) {

    logger.error(
      'handleRoadmapWeekly failed:',
      err
    );

    await telegramClient.editMessage(
      this.bot,
      chatId,
      messageId,
      'Failed generating weekly breakdown.'
    );
  }
}

}

module.exports = CallbackHandler;