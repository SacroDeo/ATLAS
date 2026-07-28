// src/bot/callbacks/taskCallbacks.js
const { safeReply, answerCallback } = require('../../utils/telegram/replyBuilder');
const { safeEditMessage } = require('../../utils/telegram/editMessageSafe');
const inlineKeyboards = require('../keyboards/inlineKeyboards');

module.exports = {
  async handle({ callbackQuery, ctx, action, id, extra }) {

    switch (action) {

      case 'done':
        return ctx.handleDone(callbackQuery, id);

      case 'skip':
        return ctx.handleSkipRequest(callbackQuery, id);

      case 'skipreason':
      case 'sr':
        return ctx.handleSkipReason(callbackQuery, id, extra);

      case 'toohard':
        return ctx.handleTooHard(callbackQuery, id);
      
      case 'socratic':
        return ctx.handleSocraticPrompt(callbackQuery, id);

      case 'socraticskip': 
        return ctx.handleSkipSocratic(callbackQuery);

      case 'restore':
        return ctx.handleRestore(callbackQuery, id);

      case 'completed':
        return answerCallback(ctx, 'Task already completed.', { showAlert: false });

      default:
        throw new Error(`Unknown task action: ${action}`);
    }
  }
};