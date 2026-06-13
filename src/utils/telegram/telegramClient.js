// src/utils/telegram/telegramClient.js
// Single authority for all outbound Telegram API calls.
// Centralizes retry logic, rate-limit backoff, and parse_mode fallback.
// Usage: require this instead of calling bot.sendMessage directly.

const logger = require('../logger');
const { sanitizeTelegramText } = require('./safeMarkdown');
const { splitMessage } = require('./messageChunks');

const RETRY_COUNT = 3;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Internal retry executor — all Telegram ops go through this.
 * Handles: rate limits, markdown parse errors, network blips.
 *
 * @param {Function} operation - Async function that performs one Telegram API call
 * @param {Object} opts
 * @param {boolean} opts.allowMarkdownFallback - Retry without parse_mode on entity error
 * @param {Object} opts.mutableOptions - Options object mutated between retries (parse_mode stripped)
 * @returns {Promise<any>}
 */
async function executeTelegramOperation(operation, opts = {}) {
  const { allowMarkdownFallback = true, mutableOptions = null } = opts;
  let lastError = null;

  for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const desc = err.description || err.message || '';

      // Not modified — silent success
      if (desc.includes('message is not modified')) {
        return null;
      }

      // Hard failures — no point retrying
      if (
        desc.includes('message to edit not found') ||
        desc.includes('chat not found') ||
        desc.includes('bot was blocked') ||
        desc.includes('user is deactivated')
      ) {
        throw err;
      }

      // Markdown parse error — strip parse_mode and retry immediately
      if (allowMarkdownFallback && mutableOptions && desc.includes("can't parse entities")) {
        logger.warn(`[telegramClient] Markdown parse error on attempt ${attempt + 1}, retrying plain`);
        delete mutableOptions.parse_mode;
        continue;
      }

      // Rate limit — respect Telegram's retry_after header
      if (desc.includes('Too Many Requests')) {
        const retryAfter = (err.parameters?.retry_after || attempt + 1) * 1000;
        logger.warn(`[telegramClient] Rate limited, waiting ${retryAfter}ms`);
        await delay(retryAfter);
        continue;
      }

      // Transient error — exponential backoff
      if (attempt < RETRY_COUNT - 1) {
        await delay(BASE_RETRY_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }

  throw lastError;
}

/**
 * Send a message, chunking automatically if over 4096 chars.
 * Sanitizes text (control chars, newlines) but does NOT escape —
 * pass pre-escaped MarkdownV2 or plain text.
 *
 * @param {Object} bot - Telegraf/node-telegram-bot-api bot instance
 * @param {number|string} chatId
 * @param {string} text
 * @param {Object} extraOptions - parse_mode, reply_markup, etc.
 * @returns {Promise<Object>} Last sent message
 */
async function sendMessage(bot, chatId, text, extraOptions = {}) {
  const cleaned = sanitizeTelegramText(String(text || ''));
  const chunks = splitMessage(cleaned);

  let lastResult = null;

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const options = { parse_mode: 'MarkdownV2', ...extraOptions };

    // Keyboard only on last chunk
    if (!isLast) delete options.reply_markup;

    // Chunk label for multi-part messages
    const chunkText = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n${chunks[i]}` : chunks[i];

    lastResult = await executeTelegramOperation(
      () => bot.sendMessage(chatId, chunkText, options),
      { allowMarkdownFallback: true, mutableOptions: options }
    );
  }

  return lastResult;
}

/**
 * Edit an existing message.
 *
 * @param {Object} bot
 * @param {number|string} chatId
 * @param {number} messageId
 * @param {string} text
 * @param {Object} extraOptions
 * @returns {Promise<Object|null>} null if message was unchanged
 */
async function editMessage(bot, chatId, messageId, text, extraOptions = {}) {
  const cleaned = sanitizeTelegramText(String(text || ''));

  // Truncate for edits — no chunking (edit replaces single message)
  const truncated = cleaned.length > MAX_MESSAGE_LENGTH
    ? cleaned.slice(0, MAX_MESSAGE_LENGTH - 3) + '...'
    : cleaned;

  const options = { chat_id: chatId, message_id: messageId, parse_mode: 'MarkdownV2', ...extraOptions };

  return executeTelegramOperation(
    () => bot.editMessageText(truncated, options),
    { allowMarkdownFallback: true, mutableOptions: options }
  );
}

/**
 * Answer a callback query safely. Never throws.
 *
 * @param {Object} bot
 * @param {string} callbackQueryId
 * @param {string} text
 * @param {boolean} showAlert
 */
async function answerCallbackQuery(bot, callbackQueryId, text = '', showAlert = false) {
  try {
    await bot.answerCallbackQuery(callbackQueryId, { text, show_alert: showAlert });
  } catch (err) {
    // Expired queries are not worth logging as errors
    logger.debug(`[telegramClient] answerCallbackQuery failed: ${err.message}`);
  }
}

/**
 * Delete a message safely. Never throws.
 *
 * @param {Object} bot
 * @param {number|string} chatId
 * @param {number} messageId
 * @returns {Promise<boolean>}
 */
async function deleteMessage(bot, chatId, messageId) {
  try {
    await executeTelegramOperation(
      () => bot.deleteMessage(chatId, messageId),
      { allowMarkdownFallback: false }
    );
    return true;
  } catch (err) {
    logger.debug(`[telegramClient] deleteMessage failed (ok): ${err.message}`);
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  sendMessage,
  editMessage,
  answerCallbackQuery,
  deleteMessage,
  // Exposed for callers that need raw retry wrapping (e.g. ctx-based Telegraf ops)
  executeTelegramOperation,
};