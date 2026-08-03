// src/bot/callbacks/callbackRouter.js
const taskCallbacks = require('./taskCallbacks');
const roadmapCallbacks = require('./roadmapCallbacks');
const checkinCallbacks = require('./checkinCallbacks');
const menuCallbacks = require('./menuCallbacks');
const adminCallbacks = require('./adminCallbacks');
const logger = require('../../utils/logger');
const { answerCallback } = require('../../utils/telegram/replyBuilder');

/**
 * Central callback router.
 * Parses:
 * domain:action:id:extra
 */
class CallbackRouter {

  constructor() {
    this.routes = {
      task: taskCallbacks,
      roadmap: roadmapCallbacks,
      checkin: checkinCallbacks,
      menu: menuCallbacks,
      admin: adminCallbacks,
    };
  }

  async route(callbackQuery, ctx) {

    const data = callbackQuery.data || '';

    if (!data || typeof data !== 'string') {
      logger.warn('[callbackRouter] Invalid callback data');
      await answerCallback(ctx, 'Invalid action.', { showAlert: false });
      return;
    }

    // Legacy onboarding callbacks intentionally bypass router migration for now
    if (!data.includes(':')) {
      if (ctx.onboardingFlow) {
        return ctx.onboardingFlow.handleCallback(callbackQuery);
      }

      logger.warn(`[callbackRouter] Legacy callback without onboardingFlow: ${data}`);
      return answerCallback(ctx, 'Unknown action.', { showAlert: false });
    }

    const parts = data.split(':');
const domain = parts[0];
const action = parts[1];
const id = parts[2];
const extra = parts.slice(3).join(':');

    logger.info(`[callbackRouter] domain=${domain}, action=${action}, id=${id}, extra=${extra}`);

    const handler = this.routes[domain];

    if (!handler) {
      logger.warn(`[callbackRouter] Unknown callback domain: ${domain}`);
      return answerCallback(ctx, 'Unknown action.', { showAlert: false });
    }

    try {
      return await handler.handle({ callbackQuery, ctx, action, id, extra });
    } catch (error) {
      logger.error(`[callbackRouter] Error routing ${data}:`, error);
      return answerCallback(ctx, 'Something went wrong.', { showAlert: false });
    }
  }
}

module.exports = new CallbackRouter();