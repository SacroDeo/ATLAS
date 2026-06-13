// src/core/execution/executors/generalChatExecutor.js

const conversationEngine = require('../../../services/ai/conversationEngine');

class GeneralChatExecutor {
  async execute(plan, context) {
    try {
      const response = await conversationEngine.generateAdaptiveResponse(
        context.messageText,
        context.history,
        context.user
      );

      // save assistant response to history
      await conversationEngine.appendHistory(context.user.id, 'assistant', response);

      return {
        success: true,
        message: response
      };
    } catch (error) {
      return {
        success: true,
        message: "I'm here with you. What's on your mind?"
      };
    }
  }
}

module.exports = new GeneralChatExecutor();