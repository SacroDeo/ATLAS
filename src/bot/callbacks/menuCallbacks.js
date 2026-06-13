// src/bot/callbacks/menuCallbacks.js

module.exports = {

  async handle({
    callbackQuery,
    ctx,
    action,
  }) {

    const {
      chatId,
      messageId,
      user,
    } =
      await ctx._getCallbackContext(
        callbackQuery
      );

    switch (action) {

      case 'progress':
        return ctx.showProgress(
          chatId,
          messageId,
          user
        );

      case 'stats':
        return ctx.showStats(
          chatId,
          messageId,
          user
        );

      case 'goal':
        return ctx.showGoal(
          chatId,
          messageId,
          user
        );

      case 'review':
        return ctx.showReview(
          chatId,
          messageId,
          user
        );

      case 'help':
        return ctx.showHelp(
          chatId,
          messageId
        );

      default:
        throw new Error(
          `Unknown menu action: ${action}`
        );
    }
  }
};
