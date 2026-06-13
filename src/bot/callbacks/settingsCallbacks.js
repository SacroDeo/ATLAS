// src/bot/callbacks/settingsCallbacks.js

module.exports = {
  async handle(callbackQuery, handlerContext) {
    const data = callbackQuery.data;

    if (data.startsWith('settings:')) {
      return handlerContext.handleSettingsCallback(callbackQuery);
    }

    throw new Error(`Unknown settings callback: ${data}`);
  }
};
