// src/bot/callbacks/callbackRouter.js
const taskCallbacks = require('./taskCallbacks');
const roadmapCallbacks = require('./roadmapCallbacks');
const checkinCallbacks = require('./checkinCallbacks');
const menuCallbacks = require('./menuCallbacks');
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

    const [domain, action, id, extra] = data.split(':');

    logger.info(`[callbackRouter] domain=${domain}, action=${action}, id=${id}, extra=${extra}`);

    const handler = this.routes[domain];

    if (!handler) {
      logger.warn(`[callbackRouter] Unknown callback domain: ${domain}`);
      return answerCallback(ctx, 'Unknown action.', { showAlert: false });
    }

    try {
      return handler.handle({ callbackQuery, ctx, action, id, extra });
    } catch (error) {
      logger.error(`[callbackRouter] Error routing ${data}:`, error);
      return answerCallback(ctx, 'Something went wrong.', { showAlert: false });
    }
  }
}

module.exports = new CallbackRouter();