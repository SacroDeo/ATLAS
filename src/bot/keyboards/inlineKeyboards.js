// src/bot/keyboards/inlineKeyboards.js
// All keyboards now use safe callback data format

const inlineKeyboards = {
  taskActions(taskId) {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Done', callback_data: `task:done:${taskId}` },
            { text: '⏭️ Skip', callback_data: `task:skip:${taskId}` },
            { text: '😰 Too Hard', callback_data: `task:toohard:${taskId}` },
          ],
        ],
      },
    };
  },

    skipReasons(taskId) {
    // 'sr' + 2-char reason codes keep callback_data under Telegram's 64-byte limit
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⏰ No Time', callback_data: `task:sr:${taskId}:nt` },
            { text: '📚 Too Difficult', callback_data: `task:sr:${taskId}:td` },
          ],
          [
            { text: '❌ Not Relevant', callback_data: `task:sr:${taskId}:nr` },
            { text: '😔 Lost Motivation', callback_data: `task:sr:${taskId}:lm` },
          ],
          [
            { text: '🚨 Personal Emergency', callback_data: `task:sr:${taskId}:pe` },
          ],
        ],
      },
    };
  },

  socraticPrompt(taskId) {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Answer Now', callback_data: `task:socratic:${taskId}` }],
          [{ text: '⏭️ Skip Question', callback_data: `task:socraticskip:${taskId}` }],
        ],
      },
    };
  },

  stuckCheckin() {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🤔 Technical Confusion', callback_data: 'checkin:stuck:technical' },
            { text: '😴 Lost Motivation', callback_data: 'checkin:stuck:motivation' },
          ],
          [
            { text: '📅 Too Busy', callback_data: 'checkin:stuck:busy' },
            { text: '😰 Overwhelmed', callback_data: 'checkin:stuck:overwhelmed' },
          ],
        ],
      },
    };
  },

  mainMenu() {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📊 Progress', callback_data: 'menu:progress' },
            { text: '📈 Stats', callback_data: 'menu:stats' },
          ],
          [
            { text: '🎯 My Goal', callback_data: 'menu:goal' },
            { text: '📋 Review', callback_data: 'menu:review' },
          ],
          [
            { text: '🗺️ Roadmap', callback_data: 'roadmap:menu' },
            { text: '❓ Help', callback_data: 'menu:help' },
          ],
        ],
      },
    };
  },
    pendingDecision() {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⏭️ Skip them & get fresh tasks', callback_data: 'pending:skipall' }],
          [{ text: '📌 Keep them — I\'ll finish them myself', callback_data: 'pending:keep' }],
        ],
      },
    };
  },

  // Shown when the request ADDS tasks (topic-specific) on top of unfinished work,
  // rather than replacing. Either keep the unfinished ones too, or skip them first.
  pendingAppendDecision() {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Keep both & add new', callback_data: 'pending:addkeep' }],
          [{ text: '⏭️ Skip unfinished, then add', callback_data: 'pending:addskip' }],
        ],
      },
    };
  },

  roadmapMenu() {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🗺️ Full Roadmap', callback_data: 'roadmap:full' },
            { text: '📅 Weekly Breakdown', callback_data: 'roadmap:weekly' },
          ],
          [
            { text: '📍 Current Phase', callback_data: 'roadmap:phase' },
            { text: '📋 Use my own roadmap', callback_data: 'roadmap:own' },
          ],
        ],
      },
    };
  },
};

module.exports = inlineKeyboards;