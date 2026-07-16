// src/bot/handlers/messageHandler.js
// src/bot/handlers/messageHandler.js
const memoryService = require('../../services/memory/memoryService');
const contextBuilder = require('../../core/context/contextBuilder');
const stateManager = require('../../core/state/stateManager');
const actionRegistry = require('../../core/actions/actionRegistry');
const ACTIONS = require('../../core/actions/actionTypes');
const actionExecutor = require('../../core/execution/actionExecutor');
const actionPlanner = require('../../core/planner/actionPlanner');
const actionValidator = require('../../core/validation/actionValidator');
const rateLimiter = require('../../services/ai/rateLimiter');
const conversationEngine = require('../../services/ai/conversationEngine');
const telegramMessage = require('../../utils/telegramMessage');
const OnboardingFlow = require('../onboarding/onboardingFlow');
const StartCommand = require('../commands/start');
const userQueries = require('../../database/queries/userQueries');
const taskQueries = require('../../database/queries/taskQueries');
const taskService = require('../../services/tasks/taskService');
const dailyTaskGenerator = require('../../services/ai/dailyTaskGenerator');
const socraticEvaluator = require('../../services/ai/socraticEvaluator');
const socraticQueries = require('../../database/queries/socraticQueries');
const checkinQueries = require('../../database/queries/checkinQueries');
const reviewService = require('../../services/reviews/reviewService');
const personalityService = require('../../services/personality/personalityService');
const aiOrchestrator = require('../../services/ai/aiOrchestrator');
const inlineKeyboards = require('../keyboards/inlineKeyboards');
const timezoneUtils = require('../../utils/timezoneUtils');
const logger = require('../../utils/logger');
const { telegramErrorHandler } = require('../../utils/errorHandler');
const { dailyCron } = require('../../cron/dailyCron');
const generalChatExecutor = require('../../core/execution/executors/generalChatExecutor');
const telegramClient = require('../../utils/telegram/telegramClient');
const atlasCommands = require('../../utils/atlasCommands');

class MessageHandler {
  constructor(bot) {
    this.bot = bot;
    this.onboardingFlow = new OnboardingFlow(bot);
    this.startCommand = new StartCommand(bot);
    this.activeStates = stateManager.states;
    this.processingQueue = new Map();
    this.callbackHandler = null;
  }

  setCallbackHandler(callbackHandler) {
    this.callbackHandler = callbackHandler;
  }

  async _queueMessage(userId, fn) {
    if (!this.processingQueue.has(userId)) {
      this.processingQueue.set(userId, Promise.resolve());
    }
    const queue = this.processingQueue.get(userId).then(() => fn()).catch(() => {});
    this.processingQueue.set(userId, queue);
    return queue;
  }

  async handleMessage(msg) {
    const telegramId = msg.from.id;
    return this._queueMessage(telegramId, () => this._handleMessageInner(msg));
  }

  async _handleMessageInner(msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const text = msg.text;

    if (!text || text.trim() === '') return;

    try {
      const user = await userQueries.getUserByTelegramId(telegramId);

      // ── PRIORITY 1: Not onboarded ─────────────────────────────────────────
      if (!user || !user.onboarding_completed) {
        await this.onboardingFlow.handleOnboarding(msg);
        return;
      }

      // ── PRIORITY 2: Commands ──────────────────────────────────────────────
      if (text.startsWith('/')) {
        await this.handleCommand(chatId, telegramId, text, user);
        return;
      }

      // ── PRIORITY 3: State machine states ──────────────────────────────────
      const currentState = stateManager.get(user.telegram_id);
      if (currentState === 'awaiting_task_generation_confirmation') {
        const lower = text.toLowerCase().trim();
        if (lower === 'yes' || lower === 'generate tasks' || lower === 'yes generate') {
          stateManager.clear(user.telegram_id);
          await this.handleConversationalMessage(chatId, 'generate tasks', user);
          return;
        }
        if (lower === 'no' || lower === 'cancel') {
          stateManager.clear(user.telegram_id);
          await telegramClient.sendMessage(this.bot, chatId, 'Okay, cancelled.');
          return;
        }
      }
      if (currentState === 'adding_task') {
        await this.handleAddTaskDescription(chatId, text, user);
        return;
      }
      if (currentState === 'awaiting_timezone_change') {
        stateManager.clear(user.telegram_id);
        await this.handleTimezoneChangeInput(chatId, text, user);
        return;
      }
      if (currentState && currentState.startsWith('confirming_delete_')) {
        const taskId = currentState.replace('confirming_delete_', '');
        const lowerText = text.toLowerCase().trim();
        if (lowerText === 'yes' || lowerText === 'yes delete it' || lowerText === 'delete' || lowerText === 'confirm') {
          stateManager.clear(user.telegram_id);
          try {
            const task = await taskQueries.getTaskById(taskId);
            await taskQueries.deleteTask(taskId);
            await telegramClient.sendMessage(this.bot, chatId, `✅ Task "${task.title}" has been deleted.`);
          } catch (error) {
            logger.error('Delete confirmation failed:', error);
            await telegramClient.sendMessage(this.bot, chatId, '❌ Failed to delete. Try again.');
          }
        } else {
          stateManager.clear(user.telegram_id);
          await telegramClient.sendMessage(this.bot, chatId, '❌ Deletion cancelled. Your task is safe.');
        }
        return;
      }

      // ── PRIORITY 4: Socratic questions ────────────────────────────────────
      const unansweredLogs = await socraticQueries.getUnansweredLogs(user.id);
      if (unansweredLogs.length > 0) {
        const latestLog = unansweredLogs[0];
        const logAge = Date.now() - new Date(latestLog.created_at).getTime();
        const tenMinutes = 10 * 60 * 1000;
        if (logAge >= tenMinutes) {
          await socraticQueries.clearAwaitingResponse(user.id);
        } else {
          if (text.startsWith('/start') || text.startsWith('/today')) {
            await telegramClient.sendMessage(
              this.bot,
              chatId,
              '🤔 *Hold on!*\n\nYou have an unanswered understanding check. Please answer the question below before continuing:\n\n' +
              `"${latestLog.question}"\n\nJust reply with your answer directly.`,
              { parse_mode: 'Markdown' }
            );
            return;
          }
          await this.handleSocraticResponse(chatId, text, user, latestLog);
          return;
        }
      }

      // ── PRIORITY 5: Rate limiting ─────────────────────────────────────────
      const rateCheck = rateLimiter.checkMessage(user.telegram_id);
      if (!rateCheck.allowed) {
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          `⏳ You're sending messages too fast. Please wait ${rateLimiter.formatRetryTime(rateCheck.retryAfterSeconds)} before trying again.`
        );
        return;
      }
      if (rateCheck.warn) {
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          `⚠️ You're approaching the message limit (${rateLimiter.LIMITS.MESSAGES_PER_MINUTE}/min). Slow down a bit to avoid being temporarily blocked.`
        );
      }

      // ── PRIORITY 6: Life struggle, progressive, morning question ──────────
      const userTimezone = user.timezone || 'UTC';
      const userTodayDate = timezoneUtils.getCurrentTimeInZone(userTimezone).toISOString().split('T')[0];
      
      const isActionMessage = (t) => {
        const l = t.toLowerCase().trim();
        return (
          l.startsWith('delete') ||
          l.startsWith('add task') ||
          l.startsWith('add tasks') ||
          l.startsWith('generate') ||
          l.startsWith('show') ||
          l.startsWith('update') ||
          l.startsWith('change') ||
          l.startsWith('start now') ||
          l.startsWith('/') ||
          l === 'yes' || l === 'no' || l === 'cancel'
        );
      };

      // NEW
if (user.onboarding_completed && !user.life_struggle && !isActionMessage(text)) {
  const freshUser = await userQueries.getUserByTelegramId(telegramId);
  if (freshUser && !freshUser.life_struggle) {
    await this.onboardingFlow._handleLifeStruggleAnswer(chatId, telegramId, text, freshUser);
    return;
  }
}

      if ((user.progressive_onboarding_step || 0) > 0 && this.callbackHandler) {
        const consumed = await this.callbackHandler.handleProgressiveAnswer(chatId, telegramId, text, user);
        if (consumed) return;
      }

      // Morning question atomic update
      if (
        user.last_morning_question_date === userTodayDate &&
        !user.morning_answer_received_today &&
        !isActionMessage(text)
      ) {
        const { supabase } = require('../../config/supabase');
        const { data, error } = await supabase
          .from('users')
          .update({
            morning_answer_received_today: true,
            last_morning_answer: text,
          })
          .eq('telegram_id', telegramId)
          .eq('morning_answer_received_today', false)
          .select('morning_answer_received_today')
          .single();

        if (data && !error) {
          await telegramClient.sendMessage(
            this.bot,
            chatId,
            `Got it — I'll keep that in mind as we tackle today together. 💪`
          );
        }
        return;
      }

      // ── Fetch user ONCE for all remaining priority checks ─────────────────
      const freshUser = await userQueries.getUserByTelegramId(telegramId);

      // ── PRIORITY 7: Task mode not set yet ─────────────────────────────────
      if (!freshUser.task_mode) {
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          "*How do you want to handle your daily tasks?*\n\n" +
          "1️⃣ *AI generates them* — I build tasks daily based on your roadmap\n" +
          "2️⃣ *You enter them* — You tell me what to work on, I track everything",
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🤖 AI Generates My Tasks', callback_data: 'finalmode_ai'     }],
                [{ text: '✏️ I Enter My Own Tasks',  callback_data: 'finalmode_manual' }],
              ],
            },
          }
        );
        return;
      }

      // ── PRIORITY 8: MANUAL TASK ENTRY MODE ────────────────────────────────
      if (freshUser.input_mode === 'manual_task_entry') {
        await this.handleManualTaskEntry(chatId, text, freshUser);
        return;
      }

      // ── PRIORITY 9: Structured action messages ─────────────────────────────
      const lower = text.toLowerCase().trim();

      // Roadmap intent — checked BEFORE generic 'show' catch
      if (lower.includes('roadmap') || lower.includes('my plan') || lower.includes('show plan')) {
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          '🗺️ *Your Roadmap*\n\nWhat would you like to see?',
          { parse_mode: 'Markdown', ...inlineKeyboards.roadmapMenu() }
        );
        return;
      }

      // Ambiguous short "show" — ask what they mean
      if (lower === 'show' || lower === 'show me') {
        const clarification = await conversationEngine.generateClarificationQuestion(
          text,
          { intent: 'SHOW_SOMETHING', ambiguous: true },
          freshUser
        );
        await telegramClient.sendMessage(this.bot, chatId, clarification, { parse_mode: 'Markdown' });
        return;
      }

      // Settings phrases — must run BEFORE the generic "change..." catch
      // below routes them into the AI planner (which has no such intent).
      if (/^(change|set|update)\s+(my\s+)?(delivery\s+)?time\b/.test(lower) || lower === 'change time') {
        await this.handleChangeTime(chatId, freshUser);
        return;
      }
      if (/^(change|set|update)\s+(my\s+)?time\s*zone\b/.test(lower) || lower === 'change timezone') {
        stateManager.set(freshUser.telegram_id, 'awaiting_timezone_change');
        await this.handleChangeTimezone(chatId, freshUser);
        return;
      }

      if (
        lower.startsWith('add task') || lower.startsWith('add tasks') ||
        lower.startsWith('generate') || lower.startsWith('show') ||
        lower.startsWith('start now') || lower.startsWith('delete') ||
        lower.startsWith('update') || lower.startsWith('change')
      ) {
        await this.handleConversationalMessage(chatId, text, freshUser);
        return;
      }

      // ── PRIORITY 9.5: Natural-language help ────────────────────────────────
      // So a user who never learned /help can still reach the command list by
      // just typing "help", "commands", "what can you do", etc.
      if (atlasCommands.isHelpRequest(text)) {
        await this.showHelp(chatId);
        return;
      }

      // ── PRIORITY 10: CONVERSATIONAL AI — LAST FALLBACK ONLY ────────────────
      await this.handleConversationalMessage(chatId, text, freshUser);

    } catch (error) {
      telegramErrorHandler(this.bot, chatId, error);
    }
  }
    
  async handleConversationalMessage(chatId, text, user) {
    try {
      await conversationEngine.appendHistory(user.id, 'user', text);
      await conversationEngine.clearOldHistory(user.id);
      const context = await contextBuilder.build(user.telegram_id, text);
      const plan = await actionPlanner.plan(context);
      logger.info(`Planner result: ${JSON.stringify(plan)}`);
      const validation = actionValidator.validate(plan);
      if (!validation.valid) {
        logger.error(`Invalid planner output: ${validation.error}`);
      }
      if (validation.valid) {
        const supportedIntents = [
          ACTIONS.UPDATE_GOALS,
          ACTIONS.SHOW_TASKS,
          ACTIONS.SHOW_GOAL,
          ACTIONS.SHOW_PROGRESS,
          ACTIONS.GENERATE_TASKS,
          ACTIONS.GENERAL_CHAT,
          ACTIONS.DELETE_TASKS,
          ACTIONS.DELETE_TASK,
          ACTIONS.ADD_TASK,
          ACTIONS.UPDATE_TASK,
        ];
        if (supportedIntents.includes(plan.intent)) {
          logger.info(`Executing new architecture action: ${plan.intent}`);
          const result = await actionExecutor.execute(plan, context);
          if (result.requiresInput) {
            if (plan.intent === ACTIONS.ADD_TASK) {
              stateManager.set(user.telegram_id, 'adding_task');
            }
          }
          await telegramClient.sendMessage(this.bot, chatId, result.message, {
            parse_mode: 'Markdown',
            ...(result.reply_markup ? { reply_markup: result.reply_markup } : {}),
          });
          if (result.success && result.message) {
            await conversationEngine.appendHistory(user.id, 'assistant', result.message);
          }
          return;
        }
      }
      const fallbackResult = await generalChatExecutor.execute(
        { intent: ACTIONS.GENERAL_CHAT, payload: {} },
        context
      );
      await telegramClient.sendMessage(this.bot, chatId, fallbackResult.message, inlineKeyboards.mainMenu());
    } catch (error) {
      logger.error(`Conversational response failed for user ${user.telegram_id}:`, error);
      await telegramClient.sendMessage(this.bot, chatId, '😅 Something went wrong. Try again!', inlineKeyboards.mainMenu());
    }
  }

  // ─── CORRECTED: Manual Task Entry Handler ──────────��─────────────────────

  async handleManualTaskEntry(chatId, text, user) {
    try {
      // ── STEP 1: Check for exit keywords FIRST (before any parsing) ────────
      const normalized = text.toLowerCase().trim();
      const exitKeywords = [
        'done',
        'finished',
        'that\'s all',
        'thats all',
        'exit',
        'quit',
        'stop'
      ];

      if (exitKeywords.includes(normalized)) {
        await userQueries.updateOnboardingState(user.telegram_id, 'completed', {
          input_mode: 'chat'
        });
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          '✅ Exited task entry mode. What would you like to do?',
          inlineKeyboards.mainMenu()
        );
        logger.info(`[ManualTaskEntry] User ${user.telegram_id} exited manual mode via keyword: "${normalized}"`);
        return;
      }

      // ── STEP 2: Handle system actions without exiting mode ─────────────────
      const systemActions = {
        'start now':  async () => { await this.handleStartNow(chatId, user); },
        'generate':   async () => { await this.handleConversationalMessage(chatId, 'generate tasks', user); },
        'show tasks': async () => { await this.handleViewTodayTasks(chatId, 'show tasks', user); },
      };

      if (normalized.startsWith('/')) {
        // Route commands through system while staying in manual mode
        await this.handleCommand(chatId, user.telegram_id, text, user);
        // Remind user they're still in task entry mode
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          '💡 *Still in task entry mode.* Send more tasks or type "done" when you\'re finished.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (systemActions[normalized]) {
        await systemActions[normalized]();
        // Remind user they're still in task entry mode
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          '💡 *Still in task entry mode.* Send more tasks or type "done" when you\'re finished.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // ── STEP 3: Parse tasks ───────────────────────────────────────────────
      const taskTitles = this._parseManualTasks(text);

      if (taskTitles.length === 0) {
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          "I couldn't find any tasks in your message. Try sending them like this:\n\n" +
          "1. First task\n2. Second task\n\n" +
          "Or type \"done\" to exit task entry mode.",
          inlineKeyboards.mainMenu()
        );
        return;
      }

      logger.info(`[ManualTaskEntry] Parsed ${taskTitles.length} tasks for user ${user.telegram_id}: ${taskTitles.join(' | ')}`);

      // ── STEP 4: Save tasks using centralized pipeline ─────────────────────
      const savedTasks = await this._createTasksForUser(user, taskTitles);
      logger.info(`[ManualTaskEntry] Saved ${savedTasks.length} tasks for user ${user.telegram_id}`);

      // ── STEP 5: Confirm and stay in manual mode ───────────────────────────
      let confirmText = `✅ *Added ${savedTasks.length} task${savedTasks.length !== 1 ? 's' : ''} for today:*\n\n`;
      savedTasks.forEach((task, i) => {
        confirmText += `${i + 1}\\. ${telegramMessage.escape(task.title)}\n`;
      });

      await telegramClient.sendMessage(this.bot, chatId, confirmText, {
        parse_mode: 'MarkdownV2',
        ...inlineKeyboards.mainMenu()
      });

      // Stay in manual mode for more tasks
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        '💡 *Still in task entry mode.* Send more tasks or type "done" when you\'re finished.',
        { parse_mode: 'Markdown' }
      );

    } catch (error) {
      logger.error(`[ManualTaskEntry] Failed for user ${user.telegram_id}:`, error);
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        '😅 Had trouble saving those tasks. Try again or type "done" to exit.',
        inlineKeyboards.mainMenu()
      );
    }
  }

  // ─── Centralized Task Creation Pipeline ───────────────────────────────────

  /**
   * Centralized task creation pipeline.
   * Both manual entry and single-task add flow through this.
   */
  async _createTasksForUser(user, taskTitles) {
    const todayDate = new Date().toISOString().split('T')[0];
    const tasksToCreate = taskTitles.map(title => ({
      title: title.substring(0, 500),
      description: title.substring(0, 1000),
      why_it_matters: `Moving toward: ${user.goal || 'your goal'}`,
      estimated_time: '30 minutes',
      difficulty_level: 'medium',
      assigned_date: todayDate,
      due_date: todayDate,
      is_daily: true,
      is_socratic: false,
      source: 'manual',
    }));
    const savedTasks = await taskQueries.createTasks(user.id, tasksToCreate);
    logger.info(`[_createTasksForUser] Saved ${savedTasks.length} tasks for user ${user.telegram_id}`);
    return savedTasks;
  }

  // ─── Manual Task Parser ──────────────────────────────────────────────────

  /**
   * Parses user input into individual task titles.
   * Supports:
   *   - Numbered: "1. Task A\n2. Task B"
   *   - Bulleted: "- Task A\n- Task B"
   *   - Line-separated: "Task A\nTask B"
   *   - Comma-separated: "Task A, Task B"
   * Does NOT use AI — pure structured parsing.
   */
  _parseManualTasks(text) {
    if (!text || typeof text !== 'string') return [];

    const trimmed = text.trim();

    // Try numbered format: "1. Task A\n2. Task B"
    const numberedRegex = /^\d+[\.\)]\s+(.+)$/gm;
    const numberedMatches = [...trimmed.matchAll(numberedRegex)];
    if (numberedMatches.length >= 2) {
      return numberedMatches.map(m => m[1].trim()).filter(t => t.length > 1);
    }

    // Try bulleted format: "- Task A\n- Task B" or "* Task A\n* Task B"
    const bulletedRegex = /^[-*•]\s+(.+)$/gm;
    const bulletedMatches = [...trimmed.matchAll(bulletedRegex)];
    if (bulletedMatches.length >= 2) {
      return bulletedMatches.map(m => m[1].trim()).filter(t => t.length > 1);
    }

    // Try comma-separated format with at least 1 comma
    const commaCount = (trimmed.match(/,/g) || []).length;
    if (commaCount >= 1) {
      const parts = trimmed.split(',').map(p => p.trim()).filter(p => p.length > 1);
      if (parts.length >= 2) {
        return parts;
      }
    }

    // Try line-separated (at least 2 lines)
    const lines = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 1);
    if (lines.length >= 2) {
      // Check that these aren't paragraphs — each line should be under 200 chars
      const allShort = lines.every(l => l.length < 200);
      if (allShort) {
        return lines;
      }
    }

    // Single line — requires action verb detection for safety
    if (lines.length === 1 && lines[0].length > 2 && lines[0].length < 500) {
      const actionVerbs = [
        'study', 'learn', 'watch', 'build', 'practice', 'read', 'write',
        'complete', 'finish', 'review', 'exercise', 'create', 'make', 'do',
        'run', 'walk', 'train', 'code', 'develop', 'design', 'research',
        'prepare', 'plan', 'organize', 'clean', 'fix', 'solve', 'implement',
        'setup', 'configure', 'install', 'deploy', 'test', 'debug', 'push',
        'commit', 'launch', 'publish', 'send', 'call', 'email',
        'draft', 'edit', 'proofread', 'outline', 'sketch', 'paint', 'draw'
      ];
      const firstWord = lines[0].split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
      if (actionVerbs.includes(firstWord)) {
        return [lines[0]];
      }
      // Not a task — likely casual chat. Don't parse as task.
      return [];
    }

    return [];
  }

  async handleAddTaskIntent(chatId, text, user, extracted) {
    const taskDescription = extracted?.description || '';
    const lowerText = text.toLowerCase();
    const addTaskPatterns = [
      'add task', 'add a task', 'custom task', 'new task',
      'add this task', 'create task', 'create a task',
      'i want to add', 'can you add', 'please add'
    ];
    let description = taskDescription;
    if (!description) {
      for (const keyword of addTaskPatterns) {
        const idx = lowerText.indexOf(keyword);
        if (idx !== -1) {
          const after = text.substring(idx + keyword.length).trim();
          const cleaned = after.replace(/^[:;\-\s]+/, '').trim();
          if (cleaned.length > 3) {
            description = cleaned;
            break;
          }
        }
      }
    }
    if (description) {
      await this.handleAddTaskDescription(chatId, description, user);
    } else {
      stateManager.set(user.telegram_id, 'adding_task');
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        'Sure! What task would you like to add to today\'s schedule? Just describe it and I\'ll set it up. 📝'
      );
    }
  }

  async handleAdviceRequest(chatId, text, user) {
    try {
      const messages = [
        {
          role: 'system',
          content: `You are ATLAS, a supportive personal goal assistant for ${user.first_name || 'the user'}.
Their goal: ${user.goal}
Their biggest struggle: ${user.biggest_struggle}
Current streak: ${user.current_streak} days
Daily available time: ${user.available_time}
Domain knowledge: ${user.domain_knowledge || 'Not specified'}

Give a helpful, specific 2-3 sentence piece of advice based on their message. Be warm, practical, and reference their actual goal and struggle.`
        },
        { role: 'user', content: text }
      ];
      const response = await aiOrchestrator.execute(messages, { temperature: 0.7, maxTokens: 200 });
      const safeResponse = telegramMessage.escape(response);
      await telegramMessage.sendMarkdownV2(this.bot, chatId, safeResponse, inlineKeyboards.mainMenu());
    } catch (error) {
      logger.error('Advice request failed:', error);
      await telegramMessage.sendSafe(this.bot, chatId, 'I had trouble thinking of advice. Try asking differently!', inlineKeyboards.mainMenu());
    }
  }

  async handleDiscussion(chatId, text, user) {
    try {
      const messages = [
        {
          role: 'system',
          content: `You are ATLAS, a thoughtful personal goal assistant chatting with ${user.first_name || 'the user'}.
Their goal: ${user.goal}
Personality: ${user.personality_type || 'friendly'}
Current streak: ${user.current_streak} days

Have a natural, engaging 2-3 sentence discussion. Be curious and supportive. Connect your response to their goal where relevant.`
        },
        { role: 'user', content: text }
      ];
      const response = await aiOrchestrator.execute(messages, { temperature: 0.8, maxTokens: 250 });
      const safeResponse = telegramMessage.escape(response);
      await telegramMessage.sendMarkdownV2(this.bot, chatId, safeResponse, inlineKeyboards.mainMenu());
    } catch (error) {
      logger.error('Discussion failed:', error);
      await telegramMessage.sendSafe(this.bot, chatId, 'I got lost in thought. What were we talking about? 😅', inlineKeyboards.mainMenu());
    }
  }

  async handleProgressCheck(chatId, user) {
    try {
      const progress = await taskService.getTodayProgress(user.id);
      const messages = [
        {
          role: 'system',
          content: `You are ATLAS. Generate a 1-2 sentence encouraging progress update for ${user.first_name || 'the user'}.
Stats: ${progress.completed}/${progress.total} completed (${progress.percentage}%). Streak: ${user.current_streak} days.
Be warm and motivating. Reference their goal: ${user.goal}`
        }
      ];
      const response = await aiOrchestrator.execute(messages, { temperature: 0.7, maxTokens: 150 });
      const safeResponse = telegramMessage.escape(response);
      const progressText = telegramMessage.formatProgress(progress, user);
      await telegramMessage.sendMarkdownV2(this.bot, chatId, `${safeResponse}\n\n${progressText}`);
    } catch (error) {
      logger.error('Progress check failed:', error);
      await this.showProgress(chatId, user);
    }
  }

  async handleChangeTime(chatId, user) {
    const currentTime = user.preferred_time || '08:00';
    const currentDisplay = timezoneUtils.getTimezoneDisplayName
      ? `${currentTime} (${timezoneUtils.getTimezoneDisplayName(user.timezone || 'UTC')})`
      : currentTime;
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      `⏰ Your tasks currently arrive at *${currentDisplay}*\n\nSelect a new time:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🌅 6:00 AM', callback_data: `changetime_06:00` },
              { text: '☀️ 7:00 AM', callback_data: `changetime_07:00` }
            ],
            [
              { text: '🌤️ 8:00 AM', callback_data: `changetime_08:00` },
              { text: '⛅ 9:00 AM', callback_data: `changetime_09:00` }
            ],
            [
              { text: '🌞 12:00 PM', callback_data: `changetime_12:00` },
              { text: '🌆 6:00 PM', callback_data: `changetime_18:00` }
            ],
            [
              { text: '🌙 8:00 PM', callback_data: `changetime_20:00` }
            ]
          ]
        }
      }
    );
  }

  async handleChangeTimezone(chatId, user) {
    const currentTz = timezoneUtils.getTimezoneDisplayName
      ? timezoneUtils.getTimezoneDisplayName(user.timezone || 'UTC')
      : (user.timezone || 'UTC');
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      `🌍 Your current timezone is *${currentTz}*\n\nReply with your city or timezone (e.g., "New York", "London", "IST", "UTC+5:30") to change it.`,
      { parse_mode: 'Markdown' }
    );
  }

  async handleTimezoneChangeInput(chatId, text, user) {
    const parsed = timezoneUtils.parseUserInput(text);
    if (!parsed || !timezoneUtils.isValidIANA(parsed)) {
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        `❌ I couldn't recognize "${text}" as a timezone.\n\nTry a major city ("Mumbai", "London", "New York") or an offset ("UTC+5:30"). Say "change timezone" to try again.`
      );
      return;
    }
    const { supabase } = require('../../config/supabase');
    const { error } = await supabase
      .from('users')
      .update({ timezone: parsed })
      .eq('telegram_id', user.telegram_id);
    if (error) throw error;
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      `✅ Timezone updated to *${timezoneUtils.getTimezoneDisplayName(parsed)}*\n\nYour daily tasks will now arrive at ${(user.preferred_time || '08:00').slice(0, 5)} in this timezone.`,
      { parse_mode: 'Markdown' }
    );
  }

  async handleStartNow(chatId, user) {
    try {
      const userTimezone = user.timezone || 'UTC';
      const userNow = timezoneUtils.getCurrentTimeInZone(userTimezone);
      const userToday = userNow.toISOString().split('T')[0];
      if (user.last_tasks_sent_date === userToday) {
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          '✅ You already have your tasks for today! Check above or use /today to see them.',
          inlineKeyboards.mainMenu()
        );
        return;
      }
      await telegramClient.sendMessage(this.bot, chatId, '🚀 Generating your tasks right now...');
      await dailyCron.sendTasksImmediately(user.telegram_id);
      if (user.start_preference === 'manual') {
        await userQueries.updateOnboardingState(user.telegram_id, 'completed', {
          start_preference: 'today',
        });
      }
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        '✨ Your tasks are ready! Check above to start working on them.',
        inlineKeyboards.mainMenu()
      );
    } catch (error) {
      logger.error(`Start now failed for ${user.telegram_id}:`, error);
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        '😅 Had trouble generating tasks immediately. Try again or wait for your scheduled time.',
        inlineKeyboards.mainMenu()
      );
    }
  }

  async handleViewTodayTasks(chatId, text, user) {
    const lowerText = text.toLowerCase();
    const isTomorrow = lowerText.includes('tomorrow');
    if (isTomorrow) {
      await this.showAndAllowTaskModification(chatId, text, user);
      return;
    }
    try {
      const today = new Date().toISOString().split('T')[0];
      const tasks = await taskQueries.getDailyTasks(user.id, today);
      if (!tasks || tasks.length === 0) {
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          'No tasks for today yet. Use /start to generate them or wait for your scheduled delivery time.',
          inlineKeyboards.mainMenu()
        );
        return;
      }
      const pending = tasks.filter(t => t.status === 'pending');
      const completed = tasks.filter(t => t.status === 'completed');
      const skipped = tasks.filter(t => t.status === 'skipped');
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        `📋 *Today's Tasks*\n\n✅ Completed: ${completed.length} | ⏭️ Skipped: ${skipped.length} | ⏳ Pending: ${pending.length}`,
        { parse_mode: 'Markdown' }
      );
      for (const task of pending) {
        const taskMessage = telegramMessage.formatTaskMessage(task);
        await telegramMessage.sendMarkdownV2(
          this.bot,
          chatId,
          taskMessage,
          inlineKeyboards.taskActions(task.id)
        );
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (pending.length === 0) {
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          '🎉 All tasks done for today! New tasks arrive tomorrow at your scheduled time.',
          inlineKeyboards.mainMenu()
        );
      }
    } catch (error) {
      logger.error('View today tasks failed:', error);
      await telegramMessage.sendSafe(this.bot, chatId, '😅 Had trouble fetching tasks. Try /start instead.', inlineKeyboards.mainMenu());
    }
  }

  async handleGeneralChat(chatId, text, user) {
    try {
      const messages = [
        {
          role: 'system',
          content: `You are ATLAS, a friendly personal goal assistant helping ${user.first_name || 'the user'} achieve: ${user.goal}. Personality type: ${user.personality_type || 'friendly'}. Current streak: ${user.current_streak || 0} days. Biggest struggle: ${user.biggest_struggle || 'staying consistent'}. Reply warmly and specifically to what they said in 2-3 sentences. Never sound robotic.`
        },
        { role: 'user', content: text }
      ];
      const response = await aiOrchestrator.execute(messages, { temperature: 0.8, maxTokens: 200 });
      const safeResponse = telegramMessage.escape(response);
      await telegramMessage.sendMarkdownV2(this.bot, chatId, safeResponse, inlineKeyboards.mainMenu());
    } catch (error) {
      logger.error(`General chat failed for user ${user.telegram_id}:`, error);
      await telegramMessage.sendSafe(this.bot, chatId, '😅 Something went wrong. Try again!', inlineKeyboards.mainMenu());
    }
  }

  async handleAddTaskDescription(chatId, text, user) {
    try {
      stateManager.clear(user.telegram_id);
      const todayDate = new Date().toISOString().split('T')[0];
      const messages = [
        {
          role: 'system',
          content: `
Extract the user's task EXACTLY as written.

STRICT RULES:
- DO NOT rewrite the task
- DO NOT inject the user's goal
- DO NOT make the task motivational
- DO NOT expand the scope
- Preserve original meaning

Return ONLY valid JSON:
{
  "title": "",
  "description": "",
  "why_it_matters": "",
  "estimated_time": "",
  "difficulty_level": "easy|medium|hard"
}
`
        },
        { role: 'user', content: text }
      ];
      const taskData = await aiOrchestrator.executeJSON(messages, { temperature: 0.7, maxTokens: 300 });
      taskData.title = taskData.title?.trim() || text.trim().slice(0, 80);
      const normalizeDifficulty = (level) => {
        if (!level) return 'medium';
        const l = level.toLowerCase();
        if (l.includes('easy') || l.includes('low') || l.includes('beginner')) return 'easy';
        if (l.includes('hard') || l.includes('high') || l.includes('difficult') || l.includes('advanced')) return 'hard';
        return 'medium';
      };
      taskData.difficulty_level = normalizeDifficulty(taskData.difficulty_level);
      const savedTasks = await taskQueries.createTasks(user.id, [{
        ...taskData,
        assigned_date: todayDate,
        due_date: todayDate,
        is_daily: true,
        is_socratic: false,
        source: 'manual',
      }]);
      if (savedTasks && savedTasks.length > 0) {
        const task = savedTasks[0];
        const taskMessage = telegramMessage.formatTaskMessage(task);
        await telegramMessage.sendMarkdownV2(
          this.bot,
          chatId,
          `✅ Task added to today's schedule!\n\n${taskMessage}`,
          inlineKeyboards.taskActions(task.id)
        );
      }
    } catch (error) {
      logger.error('Add task failed:', error);
      if (error.code === '23505') {
        await telegramMessage.sendSafe(
          this.bot,
          chatId,
          '⚠️ A task with that name already exists for tomorrow. Try describing it differently.'
        );
      } else {
        await telegramMessage.sendSafe(this.bot, chatId, '😅 Had trouble adding that task. Try again!', inlineKeyboards.mainMenu());
      }
    }
  }

  async showAndAllowTaskModification(chatId, text, user) {
    try {
      const targetDate = text.toLowerCase().includes('tomorrow')
        ? new Date(Date.now() + 86400000).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];
      let tasks = await taskQueries.getDailyTasks(user.id, targetDate);
      if (tasks.length === 0) {
        await telegramMessage.sendSafe(this.bot, chatId, '🔄 Preparing tomorrow\'s tasks...');
        tasks = await dailyTaskGenerator.generateTasksForDate(user.telegram_id, targetDate);
      }
      if (!tasks || tasks.length === 0) {
        await telegramMessage.sendSafe(
          this.bot,
          chatId,
          'Couldn\'t generate tasks. Try again later!'
        );
        return;
      }
      const replaceMatch = text.match(
        /(?:replace|change|modify|swap)\s+task\s*(\d+)\s+(?:with|to)\s+(.+)/i
      );
      if (replaceMatch) {
        const taskIndex = parseInt(replaceMatch[1]) - 1;
        const newTaskText = replaceMatch[2].trim();
        if (taskIndex < 0 || taskIndex >= tasks.length) {
          await telegramMessage.sendSafe(this.bot, chatId, 'Invalid task number.');
          return;
        }
        const targetTask = tasks[taskIndex];
        await taskQueries.updateTask(targetTask.id, {
          title: newTaskText,
          description: newTaskText,
          updated_at: new Date().toISOString(),
        });
        await telegramMessage.sendSafe(
          this.bot,
          chatId,
          `✅ Replaced task ${taskIndex + 1} with:\n${newTaskText}`
        );
        return;
      }
    } catch (error) {
      logger.error('Task modification failed:', error);
      await telegramMessage.sendSafe(this.bot, chatId, '😅 Issue with tasks. Try again!', inlineKeyboards.mainMenu());
    }
  }

  async handleCommand(chatId, telegramId, command, user) {
    const commandsRequiringTaskMode = ['/today', '/progress', '/stats', '/review'];
    if (!user.task_mode && commandsRequiringTaskMode.includes(command)) {
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        "*How do you want to handle your daily tasks?*\n\n" +
        "1️⃣ *AI generates them* — I build tasks daily based on your roadmap\n" +
        "2️⃣ *You enter them* — You tell me what to work on, I track everything",
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🤖 AI Generates My Tasks', callback_data: 'finalmode_ai'     }],
              [{ text: '✏️ I Enter My Own Tasks',  callback_data: 'finalmode_manual' }],
            ],
          },
        }
      );
      return;
    }
    switch (command) {
      case '/start':
        await this.startCommand.execute({ chat: { id: chatId }, from: { id: telegramId } });
        break;
      case '/today':
        await this.showTodayTasks(chatId, user);
        break;
      case '/progress':
        await this.showProgress(chatId, user);
        break;
      case '/memory':
        await memoryService.updateMemory(user.id);
        await telegramClient.sendMessage(this.bot, chatId, '✅ Memory updated.');
        break;
      case '/stats':
        await this.showStats(chatId, user);
        break;
      case '/review':
        await this.showReview(chatId, user);
        break;
      case '/goal':
        await this.showGoal(chatId, user);
        break;
      case '/roadmap':
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          '🗺️ *Your Roadmap*\n\nWhat would you like to see?',
          { parse_mode: 'Markdown', ...inlineKeyboards.roadmapMenu() }
        );
        break;
      case '/help':
        await this.showHelp(chatId);
        break;
      case '/dashboard': {
        const config = require('../../config');
        await telegramClient.sendMessage(
          this.bot,
          chatId,
          '📊 *Your ATLAS Dashboard*\n\n' +
          'See your streak, completion rate, and progress charts on the web.\n\n' +
          'Sign in with this same Telegram account when it asks.',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📊 Open Dashboard', url: `${config.dashboard.url}/dashboard.html` }],
              ],
            },
          }
        );
        break;
      }
      case '/reset':
        await this.handleReset(chatId, user);
        break;
      default:
        await telegramClient.sendMessage(this.bot, chatId, 'Unknown command. Use /help.', inlineKeyboards.mainMenu());
    }
  }

  async showTodayTasks(chatId, user) {
    const tasks = await taskQueries.getDailyTasks(user.id);
    if (tasks.length === 0) return;
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      `You have ${tasks.filter(t => t.status === 'pending').length} pending tasks today.\n\nUse /start to view and complete them.`
    );
  }

  async showProgress(chatId, user) {
    const progress = await taskService.getTodayProgress(user.id);
    const progressText = telegramMessage.formatProgress(progress, user);
    await telegramMessage.sendMarkdownV2(this.bot, chatId, progressText);
  }

  async showStats(chatId, user) {
    const startOfWeek = new Date();
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay() + 1);
    const weekStats = await taskQueries.getCompletionStats(
      user.id,
      startOfWeek.toISOString().split('T')[0],
      new Date().toISOString().split('T')[0]
    );
    const statsText = telegramMessage.formatStats(user, weekStats);
    await telegramMessage.sendMarkdownV2(this.bot, chatId, statsText);
  }

  async showReview(chatId, user) {
    const review = await reviewService.getLatestReview(user.id);
    if (!review) {
      await telegramClient.sendMessage(this.bot, chatId, 'No weekly review yet. Complete your first week! 📊');
      return;
    }
    const formattedReview = await reviewService.formatReviewMessage(review);
    await telegramClient.sendMessage(this.bot, chatId, formattedReview, { parse_mode: 'Markdown' });
  }

  async showGoal(chatId, user) {
    const allGoals = [
      user.goal,
      ...(user.secondary_goals || [])
    ].filter(Boolean);
    const goals = [...new Set(allGoals.map(g => g.trim()))];
    if (goals.length === 0) {
      await telegramClient.sendMessage(this.bot, chatId, 'No goals set yet.');
      return;
    }
    let text = '🎯 Your Goals:\n\n';
    goals.forEach((goal, index) => {
      text += `${index + 1}. ${goal}\n`;
    });
    await telegramMessage.sendMarkdownV2(this.bot, chatId, telegramMessage.escape(text));
  }

  async showHelp(chatId) {
    // Command list comes from the shared source of truth (atlasCommands) so it
    // stays identical to the morning/after-generation footer. Sent as plain
    // Markdown to avoid hand-escaping every command line for MarkdownV2.
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      '🤖 *ATLAS — Your Personal Goal Assistant*\n\n' +
      '*Commands*\n' +
      atlasCommands.commandsListBold() + '\n\n' +
      '*Chat features* (just type it):\n' +
      '• "add task [description]" — Add a custom task\n' +
      '• "generate tasks on [topic]" — New tasks on a topic\n' +
      '• "change task 1 to ..." — Modify a task\n' +
      '• "delete task 2" — Remove a task\n' +
      '• "start now" — Get tasks immediately\n' +
      '• "change time" — Update delivery time\n' +
      '• Just chat — I\'ll respond conversationally\n\n' +
      '💡 Tap /start to turn today\'s tasks into ✅ buttons.\n\n' +
      'Stay consistent. Build momentum. 🚀',
      { parse_mode: 'Markdown', ...inlineKeyboards.mainMenu() }
    );
  }

  async handleSocraticResponse(chatId, text, user, socraticLog) {
    const freshLog = await socraticQueries.getLogById(socraticLog.id);
    if (freshLog && freshLog.user_response) return;
    try {
      const task = await taskQueries.getTaskById(socraticLog.task_id);
      const evaluation = await socraticEvaluator.evaluateResponse(
        user.id, socraticLog.question, text, task?.title || 'General understanding'
      );
      const updated = await socraticQueries.updateLogIfUnanswered(socraticLog.id, {
        user_response: text,
        evaluation_result: evaluation,
        understanding_level: evaluation.understanding_level,
        follow_up_required: evaluation.follow_up_required || false,
        follow_up_question: evaluation.follow_up_question || null,
      });
      if (!updated) return;
      const responses = {
        deep: '🌟 Excellent! You really understand this deeply!',
        moderate: '👍 Good understanding! Keep building on this.',
        shallow: '📚 Thanks for answering. Let\'s revisit this topic.',
        none: '🤔 No worries. Let\'s add this to your review list.',
      };
      await telegramMessage.sendSafe(
        this.bot, chatId,
        responses[evaluation.understanding_level] || responses.moderate
      );
      const lowerAnswer = text.toLowerCase().trim();
      const disengaged = await socraticEvaluator.isDisengaged(text);
      const currentDepth = socraticLog.follow_up_depth || 0;
      const MAX_SOCRATIC_DEPTH = 1;
      if (disengaged) evaluation.follow_up_required = false;
      if (evaluation.understanding_level === 'none') evaluation.follow_up_required = false;
      if (currentDepth >= MAX_SOCRATIC_DEPTH) evaluation.follow_up_required = false;
      if (evaluation.follow_up_required && evaluation.follow_up_question) {
        const safeQuestion = telegramMessage.escape(evaluation.follow_up_question);
        await telegramMessage.sendMarkdownV2(
          this.bot,
          chatId,
          `💭 *Going Deeper\\.\\.\\.*\n\n${safeQuestion}\n\nReply below:`
        );
        await socraticQueries.createLog({
          userId: user.id,
          taskId: socraticLog.task_id,
          question: evaluation.follow_up_question,
          followUpRequired: false,
          followUpDepth: currentDepth + 1,
          parentLogId: socraticLog.id,
        });
        return;
      }
    } catch (error) {
      logger.error(`handleSocraticResponse failed for user ${user.telegram_id}:`, error);
      await telegramMessage.sendSafe(this.bot, chatId, '😅 Something went wrong processing your answer. Try again!');
    }
  }

  async handleReset(chatId, user) {
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      '⚠️ Reset Profile\n\nThis will reset your onboarding. Are you sure?',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: 'Yes, Reset', callback_data: 'reset_confirm' },
            { text: 'No, Cancel', callback_data: 'reset_cancel' },
          ]],
        },
      }
    );
  }
}

module.exports = MessageHandler;
