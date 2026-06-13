// src/utils/telegram/telegramFormatter.js
// Centralized formatting utilities for Telegram messages
// Outputs Telegram-safe MarkdownV2

const { escapeMarkdown } = require('./safeMarkdown');

/**
 * Format a heading
 * @param {string} text - Heading text
 * @param {number} level - Heading level (1-3)
 * @returns {string}
 */
function heading(text, level = 1) {
  const escaped = escapeMarkdown(text);
  const prefix = '#'.repeat(Math.min(level, 3));
  return `${prefix} *${escaped}*`;
}

/**
 * Format a section separator
 * @returns {string}
 */
function divider() {
  return '━━━━━━━━━━━━━━━';
}

/**
 * Format a bullet point list
 * @param {string[]} items - List items
 * @returns {string}
 */
function bulletList(items) {
  if (!items || items.length === 0) return '';
  return items.map(item => `• ${escapeMarkdown(item)}`).join('\n');
}

/**
 * Format a numbered list
 * @param {string[]} items - List items
 * @returns {string}
 */
function numberedList(items) {
  if (!items || items.length === 0) return '';
  return items.map((item, i) => `${i + 1}\\. ${escapeMarkdown(item)}`).join('\n');
}

/**
 * Format a progress bar
 * @param {number} percentage - 0-100
 * @param {number} width - Bar width in characters (default: 10)
 * @returns {string}
 */
function progressBar(percentage, width = 10) {
  const clamped = Math.max(0, Math.min(100, percentage));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return `█`.repeat(filled) + `░`.repeat(empty);
}

/**
 * Format progress with percentage and bar
 * @param {number} current - Current value
 * @param {number} total - Total value
 * @param {string} label - Optional label
 * @returns {string}
 */
function formatProgress(current, total, label = '') {
  const percentage = total > 0 ? (current / total) * 100 : 0;
  const bar = progressBar(percentage);
  const prefix = label ? `${escapeMarkdown(label)} ` : '';
  return `${prefix}${bar} ${Math.round(percentage)}% (${current}/${total})`;
}

/**
 * Format a task item for display
 * @param {Object} task - Task object
 * @param {number} index - Task index
 * @returns {string}
 */
function formatTask(task, index) {
  const escapedTitle = escapeMarkdown(task.title);
  const escapedDesc = escapeMarkdown(task.description || '');
  const escapedTime = escapeMarkdown(task.estimated_time || 'Unknown');
  const difficulty = escapeMarkdown(task.difficulty_level || 'medium');
  
  let difficultyIcon = '📊';
  if (difficulty === 'easy') difficultyIcon = '✅';
  if (difficulty === 'hard') difficultyIcon = '🔥';
  
  return `*${index}\\. ${escapedTitle}*\n\n` +
         `📝 ${escapedDesc}\n\n` +
         `⏱️ ${escapedTime} · ${difficultyIcon} ${difficulty}`;
}

/**
 * Format a roadmap phase
 * @param {Object} phase - Phase object
 * @param {string} phaseLabel - Label like "Week" or "Month"
 * @returns {string}
 */
function formatRoadmapPhase(phase, phaseLabel = 'Week') {
  const escapedName = escapeMarkdown(phase.phase_name);
  const difficulty = escapeMarkdown(phase.difficulty || 'medium');
  
  let difficultyIcon = '🟢';
  if (difficulty === 'medium') difficultyIcon = '🟡';
  if (difficulty === 'hard') difficultyIcon = '🔴';
  
  return `*${phaseLabel} ${phase.phase_index}: ${escapedName}* ${difficultyIcon} ${difficulty}`;
}

/**
 * Format a stats summary
 * @param {Object} stats - Stats object with completed, total, skipped
 * @returns {string}
 */
function formatStats(stats) {
  const lines = [];
  
  if (stats.completed !== undefined && stats.total !== undefined) {
    const percentage = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;
    lines.push(`📊 *Completion*: ${percentage}% (${stats.completed}/${stats.total})`);
  }
  
  if (stats.skipped !== undefined) {
    lines.push(`⏭️ *Skipped*: ${stats.skipped}`);
  }
  
  if (stats.streak !== undefined) {
    lines.push(`🔥 *Streak*: ${stats.streak} days`);
  }
  
  return lines.join('\n');
}

/**
 * Format an encouragement message with personality
 * @param {string} message - Base message
 * @param {string} personality - Personality type
 * @returns {string}
 */
function formatEncouragement(message, personality = 'friendly') {
  const escaped = escapeMarkdown(message);
  
  const emoji = {
    competitive: '⚡',
    friendly: '💙',
    analytical: '📐',
    gamified: '🎮'
  };
  
  const prefix = emoji[personality] || '💙';
  return `${prefix} ${escaped}`;
}

/**
 * Combine multiple formatted sections
 * @param {string[]} sections - Array of formatted strings
 * @param {string} separator - Separator between sections (default: double newline)
 * @returns {string}
 */
function combineSections(sections, separator = '\n\n') {
  return sections.filter(s => s && s.trim()).join(separator);
}

/**
 * Format a status message with icon
 * @param {string} text - Message text
 * @param {string} status - 'success', 'error', 'warning', 'info'
 * @returns {string}
 */
function statusMessage(text, status = 'info') {
  const icons = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️'
  };
  
  const icon = icons[status] || icons.info;
  return `${icon} ${escapeMarkdown(text)}`;
}

module.exports = {
  heading,
  divider,
  bulletList,
  numberedList,
  progressBar,
  formatProgress,
  formatTask,
  formatRoadmapPhase,
  formatStats,
  formatEncouragement,
  combineSections,
  statusMessage
};