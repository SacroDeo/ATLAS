// src/utils/telegram/replyBuilder.js
// Centralized message sending utilities with automatic markdown safety

const { sanitizeTelegramText } = require('./safeMarkdown');
const { prepareMessageChunks } = require('./messageChunks');
const logger = require('../logger');

const DEFAULT_OPTIONS = {
  parse_mode: 'MarkdownV2',
  disable_web_page_preview: true,
  retryCount: 2,
  retryDelay: 1000
};

/**
 * Safely send a message with automatic markdown sanitization
 * 
 * @param {Object} ctx - Telegram context
 * @param {string} text - Message text
 * @param {Object} options - Additional send options
 * @returns {Promise<Object>} - Sent message object
 */
async function safeSend(ctx, text, options = {}) {
  if (!ctx || !ctx.reply) {
    throw new Error('Invalid Telegram context');
  }
  
  const sanitized = sanitizeTelegramText(text);
  const chunks = prepareMessageChunks(sanitized, options);
  
  let lastResult = null;
  
  for (let i = 0; i < chunks.chunks.length; i++) {
    const chunk = chunks.chunks[i];
    const isLast = i === chunks.chunks.length - 1;
    
    let chunkOptions = { ...DEFAULT_OPTIONS, ...options };
    
    // Only include keyboard on last chunk to avoid duplicate keyboards
    if (!isLast && chunkOptions.reply_markup) {
      delete chunkOptions.reply_markup;
    }
    
    // Add chunk indicator for multi-chunk messages
    let finalText = chunk;
    if (chunks.chunks.length > 1) {
      finalText = `[${i + 1}/${chunks.chunks.length}]\n${chunk}`;
    }
    
    let lastError = null;
    
    for (let attempt = 0; attempt < DEFAULT_OPTIONS.retryCount; attempt++) {
      try {
        const result = await ctx.reply(finalText, chunkOptions);
        lastResult = result;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        
        // If markdown parsing failed, try without parse_mode
        if (error.description && error.description.includes('can\'t parse entities')) {
          logger.warn(`Markdown parse failed, retrying without formatting: ${error.description}`);
          delete chunkOptions.parse_mode;
          continue;
        }
        
        // Rate limit - wait and retry
        if (error.description && error.description.includes('Too Many Requests')) {
          const waitTime = (attempt + 1) * DEFAULT_OPTIONS.retryDelay;
          logger.warn(`Rate limited, waiting ${waitTime}ms`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        
        // Other errors - log and continue retry
        if (attempt < DEFAULT_OPTIONS.retryCount - 1) {
          logger.warn(`Send attempt ${attempt + 1} failed: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, DEFAULT_OPTIONS.retryDelay));
        }
      }
    }
    
    if (lastError) {
      logger.error(`Failed to send message chunk ${i + 1}:`, lastError);
      // Try one last time with plain text
      try {
        const result = await ctx.reply(finalText, { ...chunkOptions, parse_mode: undefined });
        lastResult = result;
      } catch (finalError) {
        logger.error(`Final fallback send failed:`, finalError);
        throw finalError;
      }
    }
  }
  
  return lastResult;
}

/**
 * Send a message with inline keyboard
 * 
 * @param {Object} ctx - Telegram context
 * @param {string} text - Message text
 * @param {Object} keyboard - Keyboard object from inlineKeyboards
 * @param {Object} options - Additional options
 * @returns {Promise<Object>}
 */
async function replyWithKeyboard(ctx, text, keyboard, options = {}) {
  if (!keyboard || !keyboard.reply_markup) {
    return safeSend(ctx, text, options);
  }
  
  return safeSend(ctx, text, {
    ...options,
    reply_markup: keyboard.reply_markup
  });
}

/**
 * Edit an existing message safely
 * 
 * @param {Object} ctx - Telegram context
 * @param {string} text - New message text
 * @param {Object} options - Edit options
 * @returns {Promise<Object>}
 */
async function safeEdit(ctx, text, options = {}) {
  if (!ctx || !ctx.editMessageText) {
    throw new Error('Invalid context for edit operation');
  }
  
  const sanitized = sanitizeTelegramText(text);
  const editOptions = { ...DEFAULT_OPTIONS, ...options };
  
  let lastError = null;
  
  for (let attempt = 0; attempt < DEFAULT_OPTIONS.retryCount; attempt++) {
    try {
      const result = await ctx.editMessageText(sanitized, editOptions);
      return result;
    } catch (error) {
      lastError = error;
      
      // Message is identical - ignore
      if (error.description && error.description.includes('message is not modified')) {
        logger.debug('Edit skipped - message unchanged');
        return null;
      }
      
      // Message was deleted - cannot edit
      if (error.description && error.description.includes('message to edit not found')) {
        logger.warn('Message not found for edit, will resend instead');
        throw error;
      }
      
      // Markdown parse error - try without formatting
      if (error.description && error.description.includes('can\'t parse entities')) {
        logger.warn(`Markdown parse failed on edit, retrying without formatting`);
        delete editOptions.parse_mode;
        continue;
      }
      
      if (attempt < DEFAULT_OPTIONS.retryCount - 1) {
        await new Promise(resolve => setTimeout(resolve, DEFAULT_OPTIONS.retryDelay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Send a reply with automatic fallback to send if edit fails
 * 
 * @param {Object} ctx - Telegram context
 * @param {string} text - Message text
 * @param {Object} options - Options including keyboard
 * @returns {Promise<Object>}
 */
async function safeReply(ctx, text, options = {}) {
  const hasEditTarget = ctx.callbackQuery && ctx.callbackQuery.message;
  const editOptions = { ...options };
  
  // If we have a message ID to edit, try that first
  if (hasEditTarget && options.tryEditFirst !== false) {
    try {
      // Preserve existing keyboard if none provided
      if (!editOptions.reply_markup && ctx.callbackQuery.message.reply_markup) {
        editOptions.reply_markup = ctx.callbackQuery.message.reply_markup;
      }
      
      return await safeEdit(ctx, text, editOptions);
    } catch (error) {
      // Edit failed - fall back to sending new message
      logger.warn(`Edit failed, falling back to send: ${error.message}`);
      return safeSend(ctx, text, options);
    }
  }
  
  return safeSend(ctx, text, options);
}

/**
 * Answer callback query with proper error handling
 * 
 * @param {Object} ctx - Telegram context
 * @param {string} text - Alert text
 * @param {Object} options - Answer options
 * @returns {Promise<void>}
 */
async function answerCallback(ctx, text, options = {}) {
  if (!ctx || !ctx.answerCbQuery) {
    return;
  }
  
  try {
    await ctx.answerCbQuery(text, {
      show_alert: options.showAlert || false,
      cache_time: options.cacheTime || 0
    });
  } catch (error) {
    logger.error(`Failed to answer callback: ${error.message}`);
  }
}

/**
 * Delete a message safely
 * 
 * @param {Object} ctx - Telegram context
 * @param {number} messageId - Message ID to delete
 * @param {number} chatId - Chat ID (optional, uses ctx.chat.id)
 * @returns {Promise<boolean>}
 */
async function safeDelete(ctx, messageId, chatId = null) {
  const targetChatId = chatId || ctx.chat?.id;
  
  if (!targetChatId || !messageId) {
    return false;
  }
  
  try {
    await ctx.telegram.deleteMessage(targetChatId, messageId);
    return true;
  } catch (error) {
    // Message already deleted or bot lacks permissions
    if (error.description && (
      error.description.includes('message to delete not found') ||
      error.description.includes('can\'t delete message')
    )) {
      logger.debug(`Message ${messageId} already deleted or inaccessible`);
    } else {
      logger.warn(`Failed to delete message ${messageId}: ${error.message}`);
    }
    return false;
  }
}

module.exports = {
  safeSend,
  safeReply,
  safeEdit,
  replyWithKeyboard,
  answerCallback,
  safeDelete
};