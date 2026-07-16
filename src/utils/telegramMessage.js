// src/utils/telegramMessage.js
const markdown = require('./markdown');
const logger = require('./logger');
const telegramClient = require('./telegram/telegramClient');

const PARSE_ERROR_PATTERNS = [
  'can\'t parse entities',
  'parse entities',
  'parse_mode',
  'can\'t parse',
  'Bad Request: can\'t parse',
  'Bad Request: failed to parse',
];

const MAX_MESSAGE_LENGTH = 4096;

const telegramMessage = {
  _isParseError(error) {
    if (!error || !error.message) return false;
    const lowerMessage = error.message.toLowerCase();
    return PARSE_ERROR_PATTERNS.some(pattern => lowerMessage.includes(pattern.toLowerCase()));
  },

  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  },

  _buildText(template, values) {
    if (!values || Object.keys(values).length === 0) {
      return template;
    }
    
    let result = template;
    for (const [key, value] of Object.entries(values)) {
      const escapedValue = markdown.escapeMarkdownV2(value);
      const escapedKey = this._escapeRegex(`{{${key}}}`);
      result = result.replace(new RegExp(escapedKey, 'g'), escapedValue);
    }
    return result;
  },

  _truncateIfNeeded(text) {
    if (text.length <= MAX_MESSAGE_LENGTH) return text;
    logger.warn(`Message truncated from ${text.length} to ${MAX_MESSAGE_LENGTH} characters`);
    return text.substring(0, MAX_MESSAGE_LENGTH - 3) + '...';
  },

  escape(text) {
    const markdown = require('./markdown');
    return markdown.escapeMarkdownV2(text);
  },

  async sendSafe(bot, chatId, text, extra = {}) {
    try {
      return await telegramClient.sendMessage(
  bot,chatId, this._truncateIfNeeded(String(text || '')), extra);
    } catch (error) {
      const logger = require('./logger');
      logger.error(`sendSafe failed for chat ${chatId}:`, error);
      throw error;
    }
  },

  formatTaskMessage(task) {
  if (!task) return '';
  const title = markdown.escapeMarkdownV2(task.title || 'Untitled Task');
  const description = markdown.escapeMarkdownV2(task.description || '');
  const why = markdown.escapeMarkdownV2(task.why_it_matters || '');
  const time = markdown.escapeMarkdownV2(task.estimated_time || '');
  const difficulty = markdown.escapeMarkdownV2(task.difficulty_level || 'medium');
  return `📋 *${title}*\n📝 ${description}\n💡 *Why it matters:* ${why}\n⏱️ ${time} \\| 🎯 ${difficulty}`;
},

  formatProgress(progress, user) {
    const messageFormatter = require('./messageFormatter');
    const { template, values } = messageFormatter.formatProgress(progress, user);
    return this._buildText(template, values);
  },

  formatUserGoal(user) {
    const messageFormatter = require('./messageFormatter');
    const { template, values } = messageFormatter.formatUserGoal(user);
    return this._buildText(template, values);
  },

  formatStats(user, weekStats) {
    const messageFormatter = require('./messageFormatter');
    const { template, values } = messageFormatter.formatStats(user, weekStats);
    return this._buildText(template, values);
  },

  async sendMarkdownV2(bot, chatId, template, values = {}, extra = {}) {
    const escapedText = this._truncateIfNeeded(this._buildText(template, values));
    
    try {
      return await telegramClient.sendMessage(
  bot,chatId, escapedText, {
        parse_mode: 'MarkdownV2',
        ...extra,
      });
    } catch (error) {
      if (this._isParseError(error)) {
        logger.warn(`MarkdownV2 parse failed for chat ${chatId}, falling back to plain text`);
        const plainText = markdown.unescapeMarkdown(escapedText);
        try {
          return await telegramClient.sendMessage(
  bot,chatId, this._truncateIfNeeded(plainText), extra);
        } catch (fallbackError) {
          logger.error(`Plain text fallback also failed for chat ${chatId}:`, fallbackError);
          throw fallbackError;
        }
      }
      throw error;
    }
  },

  async editMarkdownV2(bot, chatId, messageId, template, values = {}, extra = {}) {
    const escapedText = this._truncateIfNeeded(this._buildText(template, values));
    
    try {
      return await bot.editMessageText(escapedText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'MarkdownV2',
        ...extra,
      });
    } catch (error) {
      if (this._isParseError(error)) {
        logger.warn(`MarkdownV2 edit parse failed for chat ${chatId}, falling back to plain text`);
        const plainText = markdown.unescapeMarkdown(escapedText);
        try {
          return await bot.editMessageText(this._truncateIfNeeded(plainText), {
            chat_id: chatId,
            message_id: messageId,
            ...extra,
          });
        } catch (fallbackError) {
          logger.error(`Plain text fallback edit also failed for chat ${chatId}:`, fallbackError);
          throw fallbackError;
        }
      }
      throw error;
    }
  },

  async sendPlain(bot, chatId, text, extra = {}) {
    try {
      return await telegramClient.sendMessage(
  bot,chatId, this._truncateIfNeeded(text), extra);
    } catch (error) {
      logger.error(`Plain send failed for chat ${chatId}:`, error);
      throw error;
    }
  },
};

module.exports = telegramMessage;