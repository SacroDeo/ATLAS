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
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⏰ No Time', callback_data: `task:skipreason:${taskId}:no_time` },
            { text: '📚 Too Difficult', callback_data: `task:skipreason:${taskId}:too_difficult` },
          ],
          [
            { text: '❌ Not Relevant', callback_data: `task:skipreason:${taskId}:not_relevant` },
            { text: '😔 Lost Motivation', callback_data: `task:skipreason:${taskId}:lost_motivation` },
          ],
          [
            { text: '🚨 Personal Emergency', callback_data: `task:skipreason:${taskId}:personal_emergency` },
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
          ],
        ],
      },
    };
  },
};

module.exports = inlineKeyboards;