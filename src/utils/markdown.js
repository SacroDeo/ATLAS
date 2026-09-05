// src/utils/markdown.js
const markdown = {
  escapeMarkdownV2(text) {
    if (text === null || text === undefined) return '';
    if (typeof text === 'number') return String(text);
    if (typeof text === 'boolean') return String(text);
    if (Array.isArray(text)) {
      return text.map(item => this.escapeMarkdownV2(item)).join(', ');
    }
    if (typeof text === 'object') {
      try {
        return this.escapeMarkdownV2(JSON.stringify(text));
      } catch {
        return '';
      }
    }
    const normalized = String(text).normalize('NFKC');
    // Escape EXACTLY MarkdownV2's 18 reserved characters. ':' and ',' used to be
    // escaped here too, but they are NOT reserved — '\:' / '\,' are needless (and
    // in some positions invalid) escapes that risk a "can't parse entities"
    // rejection. Now consistent with escapeMarkdown / telegramUtils (BUG-009).
    return normalized
      .replace(/_/g, '\\_')
      .replace(/\*/g, '\\*')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/~/g, '\\~')
      .replace(/`/g, '\\`')
      .replace(/>/g, '\\>')
      .replace(/#/g, '\\#')
      .replace(/\+/g, '\\+')
      .replace(/\-/g, '\\-')
      .replace(/=/g, '\\=')
      .replace(/\|/g, '\\|')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\./g, '\\.')
      .replace(/\!/g, '\\!');
  },

  unescapeMarkdown(text) {
    if (!text) return '';
    return String(text)
      .replace(/\\_/g, '_')
      .replace(/\\\*/g, '*')
      .replace(/\\\[/g, '[')
      .replace(/\\\]/g, ']')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\~/g, '~')
      .replace(/\\`/g, '`')
      .replace(/\\>/g, '>')
      .replace(/\\#/g, '#')
      .replace(/\\\+/g, '+')
      .replace(/\\\-/g, '-')
      .replace(/\\=/g, '=')
      .replace(/\\\|/g, '|')
      .replace(/\\\{/g, '{')
      .replace(/\\\}/g, '}')
      .replace(/\\\./g, '.')
      .replace(/\\\!/g, '!');
  },
};

module.exports = markdown;