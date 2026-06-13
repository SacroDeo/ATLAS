// src/bot/callbacks/onboardingCallbacks.js

module.exports = {
  async handle(callbackQuery, handlerContext) {
    return handlerContext.onboardingFlow.handleCallback(callbackQuery);
  }
};
