// src/utils/telegram/safeMarkdown.js
// Telegram MarkdownV2 safe escaping utilities
// Preserves intentional formatting while escaping dangerous characters

/**
 * Escape a PLAIN text value for Telegram MarkdownV2.
 * Escapes exactly the reserved set  _ * [ ] ( ) ~ ` > # + - = | { } . !  so the
 * value can be dropped safely inside your own *bold* / # / • markup. Do NOT
 * pass text that already contains intentional MarkdownV2 — its markers would be
 * escaped into literals (use it on the dynamic value, not the whole template).
 *
 * @param {string} text - Raw plain text to escape
 * @returns {string} - Telegram MarkdownV2-safe text
 */
function escapeMarkdown(text) {
  if (!text || typeof text !== 'string') return '';
  // The previous char-by-char version tried to spare URLs and emojis, but the
  // URL test only fired after the literal prefix "tth", the emoji whitelist sat
  // inside a branch emojis can never reach (emojis aren't reserved chars), and
  // the inline-code scan copied whole spans through unescaped. The net effect
  // was UNDER-escaping: a reserved char in the wrong spot slipped past and
  // Telegram rejected the entire message with "can't parse entities" (BUG-009).
  // A plain-value escaper should escape every reserved char, full stop — this
  // now matches telegramUtils.escapeMarkdown so all MarkdownV2 escaping in the
  // codebase produces identical output.
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

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

  // Strip control characters (keep \n and \t). Written as \x escape literals so
  // this source file stays plain ASCII (no raw control bytes embedded here) —
  // covers C0 (except tab \x09 and newline \x0A), DEL, and C1 (\x7F-\x9F).
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');

  // No backslash-n unescaping here, deliberately. This function runs on EVERY
  // outgoing message, so doing it here rewrote literal backslash-n in text the
  // user themselves typed or stored: a task named "what does \n do in Python"
  // arrived with a real line break in the middle of it, and there was no way to
  // discuss the escape sequence with the bot at all (BUG-010). AI-authored text
  // is the only text that ever needed the repair — models emit backslash-n as
  // two characters and double-escape it inside JSON — so it now happens at the
  // AI boundary instead: aiOrchestrator._unescapeWhitespace covers execute(),
  // _unescapeDeep covers every string in an executeJSON() result.

  // Trim trailing spaces per line
  sanitized = sanitized.replace(/[ \t]+$/gm, '');

  // Collapse 3+ consecutive newlines to 2
  sanitized = sanitized.replace(/\n{3,}/g, '\n\n');

  // Normalize numbered list spacing
  sanitized = sanitized.replace(/^(\d+)\.\s*/gm, '$1. ');

  return sanitized.trim();
}

module.exports = {
  escapeMarkdown,
  sanitizeTelegramText,
};
