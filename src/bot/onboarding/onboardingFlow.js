// src/bot/onboarding/onboardingFlow.js
const aiOrchestrator = require('../../services/ai/aiOrchestrator');
const userQueries = require('../../database/queries/userQueries');
const timezoneUtils = require('../../utils/timezoneUtils');
const logger = require('../../utils/logger');
const { dailyCron } = require('../../cron/dailyCron');
const telegramClient = require('../../utils/telegram/telegramClient');

class OnboardingFlow {
  constructor(bot) {
    this.bot = bot;
    this.userStates = new Map();

    this.states = {
      GOAL:             'goal',
      DOMAIN_KNOWLEDGE: 'domain_knowledge',
      AVAILABLE_TIME:   'available_time',
      BIGGEST_STRUGGLE: 'biggest_struggle',
      PREFERRED_TIME:   'preferred_time',
      TIMEZONE:         'timezone',
      START_DATE:       'start_date',
      TASK_MODE:        'task_mode',
      COMPLETED:        'completed',
    };

    this.cleanupInterval = setInterval(() => this._cleanupStaleStates(), 30 * 60 * 1000);
  }

  _cleanupStaleStates() {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000;
    let cleaned = 0;
    for (const [id, s] of this.userStates.entries()) {
      if (now - s.updatedAt > maxAge) {
        this.userStates.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) logger.info(`Cleaned ${cleaned} stale onboarding states`);
  }

  async handleOnboarding(msg) {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;
    const text       = msg.text?.trim();

    try {
      // Ensure the user row exists BEFORE any branch that updates it.
      // A brand-new user's first message is almost always /start (Telegram's
      // Start button) — restarting onboarding before the row exists made
      // updateOnboardingState throw and trapped new users in an error loop.
      let user = await userQueries.getUserByTelegramId(telegramId);

      if (!user) {
        user = await userQueries.createUser(telegramId, {
          username:   msg.from.username   || '',
          first_name: msg.from.first_name || '',
          last_name:  msg.from.last_name  || '',
        });
        await this._sendWelcome(chatId, telegramId);
        return;
      }

      if (text === '/start') {
        await this._restartOnboarding(chatId, telegramId);
        return;
      }

      if (user.onboarding_completed) {
        await telegramClient.sendMessage(this.bot, chatId,
          "You're all set! Use /start to view your tasks or /help for commands."
        );
        return;
      }

      let userState = this.userStates.get(telegramId);
      if (!userState) {
        userState = {
          state: user.onboarding_state || this.states.GOAL,
          data: {
            goal:             user.goal             || null,
            domain_knowledge: user.domain_knowledge || null,
            available_time:   user.available_time   || null,
            biggest_struggle: user.biggest_struggle || null,
            preferred_time:   user.preferred_time   || null,
            timezone:         user.timezone         || null,
            start_preference: user.start_preference || null,
            task_mode:        user.task_mode        || null,
          },
          updatedAt: Date.now(),
        };
        this.userStates.set(telegramId, userState);
      }

      if (!text || text.startsWith('/')) {
        await this._resumeStep(chatId, telegramId, userState, msg);
        return;
      }

      await this._processResponse(chatId, telegramId, text, userState, user);

    } catch (error) {
      logger.error(`Onboarding error for ${telegramId}:`, error);
      this.userStates.delete(telegramId);
      await telegramClient.sendMessage(this.bot, chatId, 'Something went wrong. Type /start to try again.');
    }
  }

  async _processResponse(chatId, telegramId, text, userState, user) {
    switch (userState.state) {
      case this.states.GOAL:
        await this._processGoal(chatId, telegramId, text, userState);
        break;
      case this.states.DOMAIN_KNOWLEDGE:
        await this._processDomainKnowledge(chatId, telegramId, text, userState);
        break;
      case 'awaiting_deadline':
        await this._processDeadline(chatId, telegramId, text, userState);
        break;
      case this.states.AVAILABLE_TIME:
        await this._processAvailableTime(chatId, telegramId, text, userState);
        break;
      case this.states.TIMEZONE:
        await this._processTimezone(chatId, telegramId, text, userState);
        break;
      case 'awaiting_custom_time':
        await this._processCustomTime(chatId, telegramId, text, userState);
        break;
      case 'awaiting_manual_timezone':
        await this._processManualTimezone(chatId, telegramId, text, userState);
        break;
      case 'awaiting_start_date':
        await this._processStartDateText(chatId, telegramId, text, userState);
        break;
      default:
        await this._resumeStep(chatId, telegramId, userState, null);
    }
  }

  async _resumeStep(chatId, telegramId, userState, msg) {
    switch (userState.state) {
      case this.states.GOAL:
        await this._askGoal(chatId);
        break;
      case this.states.DOMAIN_KNOWLEDGE:
        await this._askDomainKnowledge(chatId);
        break;
      case this.states.AVAILABLE_TIME:
        await this._askAvailableTime(chatId);
        break;
      case this.states.BIGGEST_STRUGGLE:
        await this._askBiggestStruggle(chatId);
        break;
      case this.states.PREFERRED_TIME:
        await this._askPreferredTime(chatId);
        break;
      case this.states.TIMEZONE:
        await this._askTimezone(chatId, telegramId, msg?.from?.language_code);
        break;
      case this.states.START_DATE:
        await this._askStartDate(chatId);
        break;
      case this.states.TASK_MODE:
        await this._askTaskMode(chatId);
        break;
      default:
        await this._askGoal(chatId);
    }
  }

  async _askGoal(chatId) {
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      "*What's the one goal you want to work on — and when do you want to achieve it by?*\n\n" +
      "Examples:\n" +
      "• _\"Become a SOC Analyst within 6 months\"_\n" +
      "• _\"Learn Python and build a project in 3 months\"_\n" +
      "• _\"Lose 8kg by September\"_\n\n" +
      "Include a timeframe — it helps me set the right pace.",
      { parse_mode: 'Markdown' }
    );
  }

  async _processGoal(chatId, telegramId, text, userState) {
    if (!text || text.trim().length < 5) {
      await telegramClient.sendMessage(this.bot, chatId,
        "Could you be a bit more specific? Include what you want to achieve and roughly when."
      );
      return;
    }

    const hasTimeframe = /\b(\d+\s*(day|days|week|weeks|month|months|year|years)|by\s+\w+|in\s+\d+|within\s+\d+)\b/i.test(text);
    if (!hasTimeframe) {
      await telegramClient.sendMessage(this.bot, chatId,
        "Got it! One quick addition — *when do you want to achieve this by?*\n\n" +
        "E.g. '3 months', 'by December', '6 weeks' — just reply with a timeframe.",
        { parse_mode: 'Markdown' }
      );
      userState.data.goal_partial = text.trim();
      userState.state     = 'awaiting_deadline';
      userState.updatedAt = Date.now();
      this.userStates.set(telegramId, userState);
      return;
    }

    userState.data.goal = text.trim();
    userState.state     = this.states.DOMAIN_KNOWLEDGE;
    userState.updatedAt = Date.now();
    this.userStates.set(telegramId, userState);

    await userQueries.updateOnboardingState(telegramId, this.states.DOMAIN_KNOWLEDGE, {
      goal: text.trim(),
    });

    await this._askDomainKnowledge(chatId);
  }

  async _processDeadline(chatId, telegramId, text, userState) {
    const fullGoal = `${userState.data.goal_partial} — ${text.trim()}`;
    userState.data.goal = fullGoal;
    userState.state     = this.states.DOMAIN_KNOWLEDGE;
    userState.updatedAt = Date.now();
    this.userStates.set(telegramId, userState);

    await userQueries.updateOnboardingState(telegramId, this.states.DOMAIN_KNOWLEDGE, {
      goal: fullGoal,
    });

    await telegramClient.sendMessage(this.bot, chatId, `Perfect. *Goal locked in:* _${fullGoal}_`, { parse_mode: 'Markdown' });
    await this._askDomainKnowledge(chatId);
  }

  async _askDomainKnowledge(chatId) {
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      "*How familiar are you with this field right now?*\n\n" +
      "Be honest — I'll calibrate your tasks accordingly.",
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🌱 Complete Beginner',      callback_data: 'knowledge_beginner'     }],
            [{ text: '📖 Basic Understanding',    callback_data: 'knowledge_basic'        }],
            [{ text: '⚙️ Intermediate',           callback_data: 'knowledge_intermediate' }],
            [{ text: '🚀 Advanced',               callback_data: 'knowledge_advanced'     }],
          ],
        },
      }
    );
  }

  async _processDomainKnowledge(chatId, telegramId, text, userState) {
    const lower = text.toLowerCase();
    let level = 'beginner';
    if (lower.includes('advanced'))                                  level = 'advanced';
    else if (lower.includes('intermediate') || lower.includes('mid')) level = 'intermediate';
    else if (lower.includes('basic') || lower.includes('some'))      level = 'basic';

    await this._saveDomainKnowledge(chatId, telegramId, level, userState);
  }

  async _saveDomainKnowledge(chatId, telegramId, level, userState) {
    const normalized = ['beginner', 'basic', 'intermediate', 'advanced'].includes(level)
      ? level
      : 'beginner';

    userState.data.domain_knowledge = normalized;
    userState.state                 = this.states.AVAILABLE_TIME;
    userState.updatedAt             = Date.now();
    this.userStates.set(telegramId, userState);

    await userQueries.updateOnboardingState(telegramId, this.states.AVAILABLE_TIME, {
      domain_knowledge: normalized,
    });

    const labels = {
      beginner:     '🌱 Beginner — we start from the foundations.',
      basic:        '📖 Basic — I\'ll build on what you know.',
      intermediate: '⚙️ Intermediate — expect hands-on tasks early.',
      advanced:     '🚀 Advanced — straight to the hard stuff.',
    };

    await telegramClient.sendMessage(this.bot, chatId, `Got it. ${labels[normalized]}`, { parse_mode: 'Markdown' });
    await this._askAvailableTime(chatId);
  }

  async _askAvailableTime(chatId) {
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      "*How much time can you realistically set aside each day for this?*\n\n" +
      "Be honest — consistency beats intensity. " +
      "'30 minutes in the morning' works just as well as '2 hours after work'.",
      { parse_mode: 'Markdown' }
    );
  }

  async _processAvailableTime(chatId, telegramId, text, userState) {
    const hasTimeKeyword = /\b(hour|hours|minute|minutes|min|mins)\b/i.test(text);
    const hasNumber      = /\d+/.test(text);

    if (!hasTimeKeyword || !hasNumber) {
      await telegramClient.sendMessage(this.bot, chatId,
        'Include a number with hours or minutes — e.g. "1 hour", "30 minutes", "2 hours on weekdays".'
      );
      return;
    }

    userState.data.available_time = text.trim();
    userState.state               = this.states.BIGGEST_STRUGGLE;
    userState.updatedAt           = Date.now();
    this.userStates.set(telegramId, userState);

    await userQueries.updateOnboardingState(telegramId, this.states.BIGGEST_STRUGGLE, {
      available_time: text.trim(),
    });

    await this._askBiggestStruggle(chatId);
  }

  async _askBiggestStruggle(chatId) {
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      "*What usually stops you from staying consistent?*\n\n" +
      "Be honest — I'll use this to adjust pacing and task style.",      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '😰 I get overwhelmed easily',     callback_data: 'struggle_overwhelmed' }],
            [{ text: '⏳ I procrastinate',               callback_data: 'struggle_procrastination' }],
            [{ text: '🎯 I lose focus easily',          callback_data: 'struggle_focus' }],
            [{ text: '🧠 I overthink everything',       callback_data: 'struggle_overthinking' }],
            [{ text: '🔥 I burn out quickly',            callback_data: 'struggle_burnout' }],
            [{ text: '💪 I struggle with motivation',    callback_data: 'struggle_motivation' }],
            [{ text: '📱 I get distracted easily',       callback_data: 'struggle_distracted' }],
            [{ text: '⏰ I have time issues',             callback_data: 'struggle_time_issues' }],
            [{ text: '🤷 I don\'t know where to start',  callback_data: 'struggle_dont_know_where_to_start' }],
          ],
        },
      }
    );
  }

  async _saveBiggestStruggle(chatId, telegramId, struggle, userState) {
    const struggleLabels = {
      overwhelmed: 'I get overwhelmed easily',
      procrastination: 'I procrastinate',
      focus: 'I lose focus easily',
      overthinking: 'I overthink everything',
      burnout: 'I burn out quickly',
      motivation: 'I struggle with motivation',
      distracted: 'I get distracted easily',
      time_issues: 'I have time issues',
      dont_know_where_to_start: 'I don\'t know where to start',
    };

    const displayLabel = struggleLabels[struggle] || struggle;

    userState.data.biggest_struggle = displayLabel;
    userState.state                 = this.states.PREFERRED_TIME;
    userState.updatedAt             = Date.now();
    this.userStates.set(telegramId, userState);

    await userQueries.updateOnboardingState(telegramId, this.states.PREFERRED_TIME, {
      biggest_struggle: displayLabel,
    });

    await telegramClient.sendMessage(
      this.bot,
      chatId,
      `Got it — "${displayLabel}". I'll adapt your pace and task style around this.`,
      { parse_mode: 'Markdown' }
    );

    await this._askPreferredTime(chatId);
  }

  async _askPreferredTime(chatId) {
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      "*What time should I send your daily tasks?*\n\nPick one or type a custom time.",
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🌅 6:00 AM', callback_data: 'time_06:00' },
              { text: '☀️ 7:00 AM', callback_data: 'time_07:00' },
            ],
            [
              { text: '🌤️ 8:00 AM', callback_data: 'time_08:00' },
              { text: '⛅ 9:00 AM', callback_data: 'time_09:00' },
            ],
            [
              { text: '🌞 12:00 PM', callback_data: 'time_12:00' },
              { text: '🌆 6:00 PM',  callback_data: 'time_18:00' },
            ],
            [
              { text: '🌙 8:00 PM', callback_data: 'time_20:00' },
            ],
            [
              { text: '✏️ Custom Time', callback_data: 'time_custom' },
            ],
          ],
        },
      }
    );
  }

  async _processCustomTime(chatId, telegramId, text, userState) {
    const parsedTime = timezoneUtils.parseTimeInput(text);
    if (!parsedTime) {
      await telegramClient.sendMessage(this.bot, chatId,
        "Couldn't parse that time. Try something like '7:30 AM' or '9 PM'."
      );
      return;
    }

    userState.data.preferred_time = parsedTime;
    userState.state               = this.states.TIMEZONE;
    userState.updatedAt           = Date.now();
    this.userStates.set(telegramId, userState);

    await userQueries.updateOnboardingState(telegramId, this.states.TIMEZONE, {
      preferred_time: parsedTime,
    });

    await this._askTimezone(chatId, telegramId, null);
  }

  async _askTimezone(chatId, telegramId, languageCode) {
    let guessed = null;
    if (languageCode) {
      guessed = timezoneUtils.guessFromLanguageCode(languageCode);
    }

    if (guessed) {
      const displayName = timezoneUtils.getTimezoneDisplayName(guessed);
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        `I detected your timezone as *${displayName}*. Is that right?`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Yes, correct', callback_data: `tz_confirm_${guessed}` }],
              [{ text: '❌ No, let me type it', callback_data: 'tz_manual' }],
            ],
          },
        }
      );
    } else {
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        "What timezone are you in?\n\n" +
        "Type your city or country (e.g. 'India', 'London', 'New York', 'IST', 'UTC+5:30')."
      );
    }
  }

  async _processTimezone(chatId, telegramId, text, userState) {
    const parsed = timezoneUtils.parseUserInput(text);

    if (!parsed || !timezoneUtils.isValidIANA(parsed)) {
      await telegramClient.sendMessage(this.bot, chatId,
        "Couldn't find that timezone. Try a city name (e.g. 'Mumbai', 'London') or abbreviation (e.g. 'IST', 'EST')."
      );
      return;
    }

    userState.data.timezone = parsed;
    userState.state         = this.states.START_DATE;
    userState.updatedAt     = Date.now();
    this.userStates.set(telegramId, userState);

    await userQueries.updateOnboardingState(telegramId, this.states.TIMEZONE, {
      timezone: parsed,
    });

    await this._askStartDate(chatId);
  }

  async _processManualTimezone(chatId, telegramId, text, userState) {
    await this._processTimezone(chatId, telegramId, text, userState);
  }

  async _askStartDate(chatId) {
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      "📅 *When do you want to start getting tasks?*",
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Start Today',       callback_data: 'startdate_today'    }],
            [{ text: '⏰ Start Tomorrow',    callback_data: 'startdate_tomorrow' }],
            [{ text: '📅 Pick Another Day',  callback_data: 'startdate_pick'    }],
          ],
        },
      }
    );
  }

  async _processStartDateText(chatId, telegramId, text, userState) {
    userState.data.start_preference = text.trim();
    userState.state     = this.states.COMPLETED;
    userState.updatedAt = Date.now();
    this.userStates.set(telegramId, userState);

    await userQueries.updateOnboardingState(telegramId, this.states.START_DATE, {
      start_preference: text.trim(),
    });

    await this._completeOnboarding(chatId, telegramId, userState.data);
  }

  async _askTaskMode(chatId) {
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      "🧠 *How should tasks work?*\n\n" +
      "I can generate tasks based on your goal, or you can enter them yourself.\n\n" +
      "*Why entering your own tasks works better than you'd think:*\n" +
      "• You already know what matters most today\n" +
      "• Tasks you chose yourself = higher follow-through (proven)\n" +
      "• I still track everything, send reminders, and keep your plan on course\n\n" +
      "Best of both worlds? Pick *Both* — I generate a base plan, you adjust it.",
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🤖 AI Generates My Tasks',   callback_data: 'taskmode_ai'   }],
            [{ text: "✏️ I'll Enter My Own Tasks", callback_data: 'taskmode_manual' }],
            [{ text: '⚡ Both (Recommended)',       callback_data: 'taskmode_both' }],
          ],
        },
      }
    );
  }

  async _completeOnboarding(chatId, telegramId, data) {
    const startingToday = !data.start_preference || data.start_preference === 'today';
    const isManual      = data.task_mode === 'manual';

    const userDataToSave = {
      goal:                        data.goal,
      domain_knowledge:            data.domain_knowledge || null,
      available_time:              data.available_time,
      biggest_struggle:            data.biggest_struggle || null,
      preferred_time:              data.preferred_time   || '08:00',
      timezone:                    data.timezone         || 'UTC',
      task_mode:                   null,
      start_preference:            data.start_preference || 'today',
      onboarding_completed:        true,
      progressive_onboarding_step: 0,
      motivation:                  null,
      personality_type:            'friendly',
    };

    await userQueries.updateOnboardingState(telegramId, 'completed', userDataToSave);
    this.userStates.delete(telegramId);

    await telegramClient.sendMessage(
      this.bot,
      chatId,
      `✅ *You're all set!*\n\n` +
      `*How to use ATLAS:*\n` +
      `• /start — see today's tasks\n` +
      `• /progress — check today's progress\n` +
      `• /goal — view or update your goal\n` +
      `• /help — *see everything ← save this one*`,
      { parse_mode: 'Markdown' }
    );

    await telegramClient.sendMessage(this.bot, chatId, `🗺️ Generating your roadmap...`);

    try {
      const roadmapGenerator = require('../../services/ai/roadmapGenerator');
      const freshUser = await userQueries.getUserByTelegramId(telegramId);
      const roadmap = await roadmapGenerator.generate(freshUser);
      await telegramClient.sendMessage(this.bot, chatId, roadmap, { parse_mode: 'Markdown' });
      
      // NEW
await telegramClient.sendMessage(
  this.bot,
  chatId,
  'Want me to break this down into *weekly milestones*?',
  {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Yes, show weekly plan', callback_data: 'roadmap_weekly_yes' },
          { text: '⏭️ Skip',                 callback_data: 'roadmap_weekly_no'  },
        ],
      ],
    },
  }
);

// nothing needed here — life_struggle column handles state
    } catch (err) {
      logger.error(`Roadmap generation failed for ${telegramId}:`, err);
      // Keep the onboarding chain intact: task_mode hasn't been chosen yet
      // at this point, so jumping to _afterRoadmap sent tasks in a null
      // mode and skipped the life-struggle + task-mode questions entirely.
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        "⚠️ I couldn't build your full roadmap right now — I'll retry later. Let's finish your setup first."
      );
      await this._askLifeStruggle(chatId);
    }
  }

  async _sendWelcome(chatId, telegramId) {
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      "👋 Welcome to *ATLAS* — your AI personal goal assistant.\n\n" +
      "Before we set you up, let me show you exactly how this works.\n\n" +
      "_(Takes 30 seconds — don't skip this or you'll be confused later 😅)_",
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📖 Show Me How It Works →', callback_data: 'onboarding_how_it_works' }],
          ],
        },
      }
    );
  }

  async _sendWeeklyBreakdown(chatId, telegramId) {
    const user = await userQueries.getUserByTelegramId(telegramId);

    if (!user || !user.roadmap) {
      await telegramClient.sendMessage(this.bot, chatId, 'Could not find your roadmap. Type /start and try again.');
      return;
    }

    const messages = [
      {
        role: 'system',
        content: `You are ATLAS. Break this roadmap into weekly milestones.

User goal: "${user.goal}"
Available time per day: "${user.available_time}"
Roadmap:
${user.roadmap}

List weeks concisely. Format EXACTLY like this — no extra text:

*Week 1:* [specific focus]
*Week 2:* [specific focus]
*Week 3:* [specific focus]
...

Max 4 words per week focus. Max 12 weeks. No commentary before or after.`
      }
    ];

    await telegramClient.sendMessage(this.bot, chatId, '📅 Breaking it down into weeks...');

    const breakdown = await aiOrchestrator.execute(messages, { temperature: 0.6, maxTokens: 400 });

    await telegramClient.sendMessage(this.bot, chatId, breakdown.trim(), { parse_mode: 'Markdown' });

    await this._askLifeStruggle(chatId);
  }

  async _askLifeStruggle(chatId) {
    // Mark that we ASKED — the messageHandler only captures a life-struggle
    // answer while this flag is set, so casual messages ("thanks!") sent
    // when the question was never asked don't get saved as an answer.
    // (chatId === telegram_id in private chats, the only place onboarding runs.)
    try {
      const { supabase } = require('../../config/supabase');
      await supabase.from('users')
        .update({ awaiting_life_struggle: true })
        .eq('telegram_id', chatId);
    } catch (err) {
      logger.warn('Could not set awaiting_life_struggle flag:', err.message);
    }
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      "One last thing before we start.\n\n" +
      "*What's the biggest obstacle in your life right now that could get in the way of this goal?*\n\n" +
      "Not about the goal itself — about your life. Work stress, family pressure, health, sleep, money. " +
      "The more honest you are, the better I can factor it in.",
      { parse_mode: 'Markdown' }
    );
  }

  async _handleLifeStruggleAnswer(chatId, telegramId, text, user) {
    await userQueries.updateOnboardingState(telegramId, 'completed', {
  life_struggle: text.trim(),
  awaiting_life_struggle: false,
});
    await userQueries.saveProgressiveAnswer(telegramId, 'life_struggle', text.trim());

    try {
      const messages = [
        {
          role: 'system',
          content: `You are ATLAS, a practical personal goal assistant.

The user is working on: "${user.goal}"
Available time per day: "${user.available_time}"
They just told you their biggest life obstacle: "${text.trim()}"

Give 2-3 sentences of SPECIFIC, actionable advice on how to manage this obstacle alongside their goal.
Do NOT be generic. Do NOT say "that's tough" or "I understand". 
Address their specific obstacle directly and tell them exactly what to do about it.
Be concise. Be real.`
        }
      ];

      const advice = await aiOrchestrator.execute(messages, { temperature: 0.7, maxTokens: 200 });
      await telegramClient.sendMessage(this.bot, chatId, advice.trim(), { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`Life struggle AI advice failed for ${telegramId}:`, err);
      await telegramClient.sendMessage(this.bot, chatId, "Got it — I'll factor that into how I pace your tasks.");
    }

    await this._askFinalTaskMode(chatId);
  }

  async _afterRoadmap(chatId, telegramId, data, startingToday, isManual) {
    if (startingToday && !isManual) {
      try {
        await dailyCron.sendTasksImmediately(telegramId);
      } catch (err) {
        logger.error(`Failed to send immediate tasks for ${telegramId}:`, err);
      }
    }

    if (isManual) {
      await telegramClient.sendMessage(
        this.bot,
        chatId,
        "👉 Go ahead — tell me your first task. Just type it naturally:\n\n" +
        "_\"Study React hooks for 45 mins\"_\n" +
        "_\"Write 500 words for my blog post\"_",
        { parse_mode: 'Markdown' }
      );
    }
  }

  async _askFinalTaskMode(chatId) {
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      "*How do you want to handle your daily tasks?*\n\n" +
      "1️⃣ *AI generates them* — I build tasks daily based on your roadmap and progress\n" +
      "2️⃣ *You enter them* — You tell me what to work on each day, I track it and keep you on course",
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
  }

  async _sendHowItWorks(chatId) {
    await telegramClient.sendMessage(
      this.bot,
      chatId,
      '📖 *Here\'s exactly how ATLAS works:*\n\n' +
      '*Step 1 — Tell me your goal*\n' +
      'One clear goal. "Learn Python", "Get fit", "Launch my SaaS".\n\n' +
      '*Step 2 — I send tasks every day*\n' +
      'At the time you choose. Each task has clear instructions + a time estimate. No guessing.\n\n' +
      '*Step 3 — Mark them done*\n' +
      'Tap ✅ Done, ⏭️ Skip, or 😰 Too Hard. I track everything.\n\n' +
      '*Step 4 — I adapt to you*\n' +
      'The more you use it, the smarter the tasks get.\n\n' +
      '📊 *You also get:*\n' +
      '• 🔥 Daily streak tracking\n' +
      '• 📋 Weekly performance reviews every Sunday\n' +
      '• /progress to check today anytime\n' +
      '• /help to see all commands — *use this whenever you\'re lost*\n\n' +
      '💡 *You can also enter your own tasks instead of AI-generated ones* — ' +
      '• ✏️ *You can Add, delete, or replace tasks anytime*\n' +
      '• Say "add task X", "delete task 2", or "replace task 1 with Y"\n' +
      'great if you already know what you need to do and just want an assistant tracking the plan.\n\n' +
      'Setup takes under 1 minute. Ready?',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚡ Yes, Set Me Up", callback_data: 'onboarding_start' }],
          ],
        },
      }
    );
  }

  async _restartOnboarding(chatId, telegramId) {
    this.userStates.delete(telegramId);
    await userQueries.updateOnboardingState(telegramId, this.states.GOAL, {
      onboarding_completed: false,
    });
    await this._sendWelcome(chatId, telegramId);
  }

  async restartOnboarding(chatId, telegramId) {
    await this._restartOnboarding(chatId, telegramId);
  }

  async handleCallback(callbackQuery) {
    const chatId     = callbackQuery.message.chat.id;
    const telegramId = callbackQuery.from.id;
    const data       = callbackQuery.data;

    try {
      await telegramClient.answerCallbackQuery(this.bot, callbackQuery.id);

      if (data === 'onboarding_how_it_works') {
        await this._sendHowItWorks(chatId);
        return;
      }

      if (data === 'onboarding_start') {
        this.userStates.set(telegramId, {
          state:     this.states.GOAL,
          data:      {},
          updatedAt: Date.now(),
        });
        await this._askGoal(chatId);
        return;
      }

      if (data.startsWith('tz_confirm_')) {
        const timezone  = data.replace('tz_confirm_', '');
        const userState = this.userStates.get(telegramId);
        if (userState) {
          userState.data.timezone = timezone;
          userState.state         = this.states.START_DATE;
          userState.updatedAt     = Date.now();
          this.userStates.set(telegramId, userState);
          await userQueries.updateOnboardingState(telegramId, this.states.TIMEZONE, { timezone });
          await this._askStartDate(chatId);
        }
        return;
      }

      const timeButtons = ['time_06:00','time_07:00','time_08:00','time_09:00','time_12:00','time_18:00','time_20:00'];
      if (timeButtons.includes(data)) {
        const time      = data.replace('time_', '');
        const userState = this.userStates.get(telegramId);
        if (userState) {
          userState.data.preferred_time = time;
          userState.state               = this.states.TIMEZONE;
          userState.updatedAt           = Date.now();
          this.userStates.set(telegramId, userState);
          await userQueries.updateOnboardingState(telegramId, this.states.TIMEZONE, { preferred_time: time });
          await this._askTimezone(chatId, telegramId, callbackQuery.from?.language_code);
        }
        return;
      }

      if (data === 'time_custom') {
        const userState = this.userStates.get(telegramId);
        if (userState) {
          userState.state     = 'awaiting_custom_time';
          userState.updatedAt = Date.now();
          this.userStates.set(telegramId, userState);
          await telegramClient.sendMessage(this.bot, chatId, "What time? Type something like '7:30 AM' or '9 PM'.");
        }
        return;
      }

      if (data === 'tz_manual') {
        const userState = this.userStates.get(telegramId);
        if (userState) {
          userState.state     = 'awaiting_manual_timezone';
          userState.updatedAt = Date.now();
          this.userStates.set(telegramId, userState);
          await telegramClient.sendMessage(this.bot, chatId, "Type your city or timezone (e.g. 'New York', 'London', 'IST').");
        }
        return;
      }

      if (data === 'startdate_today' || data === 'startdate_tomorrow' || data === 'startdate_pick') {
        const userState = this.userStates.get(telegramId);
        if (userState) {
          if (data === 'startdate_pick') {
            userState.state     = 'awaiting_start_date';
            userState.updatedAt = Date.now();
            this.userStates.set(telegramId, userState);
            await telegramClient.sendMessage(this.bot, chatId,
              "What date should I start? (e.g. 'Monday', 'June 15', 'next week')"
            );
            return;
          }

          userState.data.start_preference = data === 'startdate_today' ? 'today' : 'tomorrow';
          userState.state     = this.states.COMPLETED;
          userState.updatedAt = Date.now();
          this.userStates.set(telegramId, userState);
          await userQueries.updateOnboardingState(telegramId, this.states.START_DATE, {
            start_preference: userState.data.start_preference,
          });
          await this._completeOnboarding(chatId, telegramId, userState.data);
        }
        return;
      }

      if (data.startsWith('knowledge_')) {
        const level     = data.replace('knowledge_', '');
        let userState   = this.userStates.get(telegramId);

        if (!userState) {
          logger.warn(`[Callback] knowledge_ — userState missing for ${telegramId}, recovering from DB`);
          const dbUser = await userQueries.getUserByTelegramId(telegramId);
          if (!dbUser) {
            await telegramClient.sendMessage(this.bot, chatId, 'Session expired. Type /start to continue.');
            return;
          }
          userState = {
            state:     this.states.DOMAIN_KNOWLEDGE,
            data: {
              goal:             dbUser.goal             || null,
              domain_knowledge: dbUser.domain_knowledge || null,
              available_time:   dbUser.available_time   || null,
              biggest_struggle: dbUser.biggest_struggle || null,
              preferred_time:   dbUser.preferred_time   || null,
              timezone:         dbUser.timezone         || null,
              start_preference: dbUser.start_preference || null,
              task_mode:        dbUser.task_mode        || null,
            },
            updatedAt: Date.now(),
          };
          this.userStates.set(telegramId, userState);
          logger.info(`[Callback] knowledge_ — userState recovered for ${telegramId}`);
        }

        await this._saveDomainKnowledge(chatId, telegramId, level, userState);
        return;
      }

      if (data.startsWith('struggle_')) {
        const struggle  = data.replace('struggle_', '');
        let userState   = this.userStates.get(telegramId);

        if (!userState) {
          logger.warn(`[Callback] struggle_ — userState missing for ${telegramId}, recovering from DB`);
          const dbUser = await userQueries.getUserByTelegramId(telegramId);
          if (!dbUser) {
            await telegramClient.sendMessage(this.bot, chatId, 'Session expired. Type /start to continue.');
            return;
          }
          userState = {
            state:     this.states.BIGGEST_STRUGGLE,
            data: {
              goal:             dbUser.goal             || null,
              domain_knowledge: dbUser.domain_knowledge || null,
              available_time:   dbUser.available_time   || null,
              biggest_struggle: dbUser.biggest_struggle || null,
              preferred_time:   dbUser.preferred_time   || null,
              timezone:         dbUser.timezone         || null,
              start_preference: dbUser.start_preference || null,
              task_mode:        dbUser.task_mode        || null,
            },
            updatedAt: Date.now(),
          };
          this.userStates.set(telegramId, userState);
          logger.info(`[Callback] struggle_ — userState recovered for ${telegramId}`);
        }

        await this._saveBiggestStruggle(chatId, telegramId, struggle, userState);
        return;
      }

      if (data === 'roadmap_weekly_yes') {
        try {
          await this._sendWeeklyBreakdown(chatId, telegramId);
        } catch (err) {
          logger.error(`Weekly breakdown failed for ${telegramId}:`, err);
          await this._askLifeStruggle(chatId);
        }
        return;
      }

      if (data === 'roadmap_weekly_no') {
        await this._askLifeStruggle(chatId);
        return;
      }

      if (data === 'finalmode_ai' || data === 'finalmode_manual') {
        // Stale-button guard: after /reset a user could tap an OLD finalmode
        // button and jump straight to "completed" with a null goal, skipping
        // onboarding entirely. Only honor this while it's actually their step.
        const currentUser = await userQueries.getUserByTelegramId(telegramId);
        if (!currentUser || !currentUser.goal) {
          await telegramClient.sendMessage(
            this.bot,
            chatId,
            'That button is from an older setup. Type /start to begin fresh.'
          );
          return;
        }

        const taskMode = data === 'finalmode_ai' ? 'ai' : 'manual';

        logger.info(`Final mode selected: ${taskMode} for user ${telegramId}`);

        try {
          await userQueries.updateOnboardingState(telegramId, 'completed', {
            task_mode: taskMode,
            // Manual mode: route the next messages into the manual task-entry
            // pipeline. Without this the "send me your first task" promise was
            // a lie — typed tasks went to the AI planner instead.
            input_mode: taskMode === 'manual' ? 'manual_task_entry' : 'chat',
          });
        } catch (err) {
          // input_mode column may not exist until migration 002 is applied —
          // never let that block onboarding completion.
          logger.error('finalmode update with input_mode failed, retrying without it (run migration 002):', err.message);
          await userQueries.updateOnboardingState(telegramId, 'completed', { task_mode: taskMode });
        }
        
        const savedUser = await userQueries.getUserByTelegramId(telegramId);
        logger.info(`Task mode verified in DB: ${savedUser?.task_mode} for user ${telegramId}`);

        this.userStates.delete(telegramId);

        await telegramClient.sendMessage(
          this.bot,
          chatId,
          taskMode === 'ai'
            ? '🤖 *AI Mode activated!* Generating your first set of tasks now...'
            : '✏️ *Manual Mode activated!* Send me your first task whenever you\'re ready.',
          { parse_mode: 'Markdown' }
        );

        if (taskMode === 'ai') {
          try {
            await new Promise(resolve => setTimeout(resolve, 500));
            logger.info(`Calling sendTasksImmediately for user ${telegramId}`);
            await dailyCron.sendTasksImmediately(telegramId);
            logger.info(`sendTasksImmediately completed for user ${telegramId}`);
          } catch (err) {
            logger.error(`Failed to send immediate tasks for ${telegramId}:`, err);
            await telegramClient.sendMessage(
              this.bot,
              chatId,
              'Had a small hiccup generating tasks. Type /start to get them now.'
            );
          }
        }

        return;
      }

      if (data === 'taskmode_ai' || data === 'taskmode_manual' || data === 'taskmode_both') {
        const userState = this.userStates.get(telegramId);
        if (userState) {
          const modeMap = { taskmode_ai: 'ai', taskmode_manual: 'manual', taskmode_both: 'both' };
          userState.data.task_mode = modeMap[data];
          userState.state          = this.states.COMPLETED;
          userState.updatedAt      = Date.now();
          this.userStates.set(telegramId, userState);
          await userQueries.updateOnboardingState(telegramId, this.states.TASK_MODE, {
            task_mode: userState.data.task_mode,
          });
          await this._completeOnboarding(chatId, telegramId, userState.data);
        }
        return;
      }

    } catch (error) {
      logger.error(`Onboarding callback error for ${telegramId}:`, error);
      await telegramClient.sendMessage(this.bot, chatId, 'Something went wrong. Type /start to begin again.');
    }
  }
}

module.exports = OnboardingFlow;
