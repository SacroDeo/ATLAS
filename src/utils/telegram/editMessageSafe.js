// src/utils/telegram/editMessageSafe.js
// Safe message editing with automatic fallback to resend

const { sanitizeTelegramText } = require('./safeMarkdown');
const { safeSend } = require('./replyBuilder');
const logger = require('../../logger');

const EDIT_RETRY_COUNT = 2;
const EDIT_RETRY_DELAY = 500;

/**
 * Safe edit wrapper with comprehensive error handling.
 * Returns raw Telegram message object, null (no-op), or throws.
 *
 * @param {Object} ctx - Telegram context
 * @param {string} text - New message text
 * @param {Object} options - Edit options
 * @param {boolean} options.fallbackToSend - Resend if edit fails (default: true)
 * @param {Object} options.fallbackKeyboard - Keyboard to use on resend
 * @param {boolean} options.preserveKeyboard - Keep existing keyboard if none provided (default: true)
 * @returns {Promise<Object|null>} - Raw Telegram result or null for no-op
 */
async function safeEditMessage(ctx, text, options = {}) {
  const {
    fallbackToSend = true,
    fallbackKeyboard = null,
    preserveKeyboard = true,
    ...editOptions
  } = options;

  if (!ctx) throw new Error('Invalid Telegram context');

  const canEdit = ctx.editMessageText && ctx.callbackQuery?.message;

  if (!canEdit) {
    if (fallbackToSend) {
      logger.debug('No editable message, sending new message instead');
      const sendOptions = fallbackKeyboard ? { reply_markup: fallbackKeyboard.reply_markup } : {};
      return safeSend(ctx, text, sendOptions);
    }
    throw new Error('No editable message available');
  }

  const sanitized = sanitizeTelegramText(text);
  const finalEditOptions = { parse_mode: 'MarkdownV2', ...editOptions };

  if (preserveKeyboard && !finalEditOptions.reply_markup && ctx.callbackQuery.message.reply_markup) {
    finalEditOptions.reply_markup = ctx.callbackQuery.message.reply_markup;
  }

  let lastError = null;

  for (let attempt = 0; attempt < EDIT_RETRY_COUNT; attempt++) {
    try {
      const result = await ctx.editMessageText(sanitized, finalEditOptions);
      return result;
    } catch (error) {
      lastError = error;

      if (error.description?.includes('message is not modified')) {
        return null;
      }

      if (error.description?.includes('message to edit not found')) {
        logger.warn('Message not found for edit');
        break;
      }

      if (error.description?.includes("can't parse entities")) {
        logger.warn('Markdown parse failed, retrying without parse_mode');
        delete finalEditOptions.parse_mode;
        continue;
      }

      if (attempt < EDIT_RETRY_COUNT - 1) {
        await new Promise((r) => setTimeout(r, EDIT_RETRY_DELAY * (attempt + 1)));
      }
    }
  }

  if (fallbackToSend) {
    logger.warn(`Edit failed after ${EDIT_RETRY_COUNT} attempts, falling back to send: ${lastError?.message}`);

    const sendOptions = {};
    if (fallbackKeyboard) {
      sendOptions.reply_markup = fallbackKeyboard.reply_markup;
    } else if (preserveKeyboard && ctx.callbackQuery.message.reply_markup) {
      sendOptions.reply_markup = ctx.callbackQuery.message.reply_markup;
    }

    try { await ctx.deleteMessage(); } catch (_) { /* ignore */ }

    return safeSend(ctx, text, sendOptions);
  }

  throw lastError;
}

/**
 * Edit message with progress indicator for long operations.
 *
 * @param {Object} ctx - Telegram context
 * @param {string} baseText - Base message text
 * @param {string} statusText - Current status to append
 * @param {Object} options - Options
 * @returns {Promise<Object|null>}
 */
async function editWithProgress(ctx, baseText, statusText, options = {}) {
  const fullText = `${baseText}\n\n⏳ *${statusText}*`;
  return safeEditMessage(ctx, fullText, options);
}

/**
 * Clear progress indicator after operation completes.
 *
 * @param {Object} ctx - Telegram context
 * @param {string} baseText - Original message text without progress
 * @param {Object} options - Options
 * @returns {Promise<Object|null>}
 */
async function clearProgress(ctx, baseText, options = {}) {
  return safeEditMessage(ctx, baseText, options);
}

/**
 * Safe edit with explicit keyboard replacement.
 *
 * @param {Object} ctx - Telegram context
 * @param {string} text - New text
 * @param {Object} keyboard - Keyboard to set
 * @param {Object} options - Additional options
 * @returns {Promise<Object|null>}
 */
async function editWithKeyboard(ctx, text, keyboard, options = {}) {
  return safeEditMessage(ctx, text, {
    ...options,
    fallbackKeyboard: keyboard,
    preserveKeyboard: false,
  });
}

module.exports = {
  safeEditMessage,
  editWithProgress,
  clearProgress,
  editWithKeyboard,
};