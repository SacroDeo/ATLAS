// src/utils/telegram/safeMarkdown.js
// Telegram MarkdownV2 safe escaping utilities
// Preserves intentional formatting while escaping dangerous characters

const MARKDOWN_RESERVED = [
  '_', '*', '[', ']', '(', ')', '~', '`', 
  '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'
];

const RESERVED_SET = new Set(MARKDOWN_RESERVED);

/**
 * Escape Telegram MarkdownV2 special characters
 * Only escapes characters that would break formatting
 * Preserves emojis, URLs, and normal text
 * 
 * @param {string} text - Raw text to escape
 * @returns {string} - Telegram-safe escaped text
 */
function escapeMarkdown(text) {
  if (!text || typeof text !== 'string') return '';
  
  let result = '';
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    
    // Preserve code blocks entirely - don't escape inside them
    if (char === '`' && nextChar === '`' && text[i + 2] === '`') {
      // Skip triple backticks - we'll handle as a block
      const codeBlockEnd = text.indexOf('```', i + 3);
      if (codeBlockEnd !== -1) {
        result += text.slice(i, codeBlockEnd + 3);
        i = codeBlockEnd + 2;
        continue;
      }
    }
    
    // Preserve inline code
    if (char === '`' && !result.endsWith('\\`')) {
      const codeEnd = text.indexOf('`', i + 1);
      if (codeEnd !== -1) {
        result += text.slice(i, codeEnd + 1);
        i = codeEnd;
        continue;
      }
    }
    
    // Escape reserved characters
    if (RESERVED_SET.has(char)) {
      // Don't escape if it's part of a URL
      const isUrlPart = (
        (char === '.' || char === '/' || char === ':' || char === '&' || char === '?') &&
        (i > 0 && text[i - 1] === 'h' && text[i - 2] === 't' && text[i - 3] === 't')
      );
      
      // Don't escape emojis (they use special chars but are fine)
      const isEmojiPart = (
        char === '❤' || char === '🔥' || char === '🎯' || char === '✅' ||
        char === '❌' || char === '⭐' || char === '💡' || char === '📊' ||
        char === '📈' || char === '🎉' || char === '🚀' || char === '📋' ||
        char === '🗺️' || char === '📍' || char === '⏱️' || char === '😰' ||
        char === '⏭️' || char === '💬'
      );
      
      if (!isUrlPart && !isEmojiPart) {
        result += '\\' + char;
      } else {
        result += char;
      }
    } else {
      result += char;
    }
  }
  
  return result;
}

/**
 * Sanitize AI-generated text for Telegram
 * More aggressive than escapeMarkdown - removes problematic patterns
 * 
/**
 * Sanitize AI-generated text for Telegram.
 * CLEANS only — does NOT escape MarkdownV2 reserved chars.
 * Call escapeMarkdown() separately if the text is plain (unformatted) input.
 * Do NOT call this on text that has already been escaped.
 *
 * @param {string} text - Raw AI-generated text (may contain intentional MarkdownV2)
 * @returns {string} - Cleaned text, formatting preserved
 */
function sanitizeTelegramText(text) {
  if (!text || typeof text !== 'string') return '';

  let sanitized = text;

  // Strip control characters (keep \n and \t)
  sanitized = sanitized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');

  // Unescape literal backslash-n sequences from JSON stringification
  sanitized = sanitized.replace(/\\n/g, '\n');
  sanitized = sanitized.replace(/\\t/g, '  ');

  // Trim trailing spaces per line
  sanitized = sanitized.replace(/[ \t]+$/gm, '');

  // Collapse 3+ consecutive newlines to 2
  sanitized = sanitized.replace(/\n{3,}/g, '\n\n');

  // Normalize numbered list spacing
  sanitized = sanitized.replace(/^(\d+)\.\s*/gm, '$1. ');

  return sanitized.trim();
}

/**
 * Check if text contains potential markdown issues
 * 
 * @param {string} text - Text to check
 * @returns {boolean} - True if text needs escaping
 */
function needsEscaping(text) {
  if (!text) return false;
  
  for (let i = 0; i < text.length; i++) {
    if (RESERVED_SET.has(text[i])) {
      // Check if it's part of a proper markdown pattern
      if (text[i] === '*' && text[i - 1] !== '\\') {
        const nextChar = text[i + 1];
        const prevChar = text[i - 1];
        
        // Likely intentional bold/italic
        if ((nextChar === '*' && prevChar === '*') || 
            (nextChar !== ' ' && prevChar !== ' ')) {
          continue;
        }
        return true;
      }
      
      if (text[i] !== ' ' && text[i] !== '\n') {
        return true;
      }
    }
  }
  
  return false;
}

module.exports = {
  escapeMarkdown,
  sanitizeTelegramText,
  needsEscaping,
  MARKDOWN_RESERVED
};