// src/core/execution/executors/generalChatExecutor.js

const conversationEngine = require('../../../services/ai/conversationEngine');
const logger = require('../../../utils/logger');

class GeneralChatExecutor {
  async execute(plan, context) {
    try {
      const response = await conversationEngine.generateAdaptiveResponse(
        context.messageText,
        context.history,
        context.user
      );

      await conversationEngine.appendHistory(context.user.id, 'assistant', response);

      return { success: true, message: response };
    } catch (error) {
      // Reaching here means every AI provider failed — ATLAS cannot think right
      // now. The old message ("I'm here with you. What's on your mind?") read as
      // a normal reply, so an outage was indistinguishable from ATLAS ignoring
      // the user, and they'd repeat themselves into the same wall. Say what's
      // actually wrong instead, and don't store it as a real conversation turn.
      logger.error(`[GeneralChat] AI unavailable for user ${context?.user?.telegram_id}:`, error);
      return {
        success: false,
        message:
          "My brain's offline for a moment — the AI service isn't responding. " +
          'Give it a minute and say that again; I should be back.',
      };
    }
  }
}

module.exports = new GeneralChatExecutor();
