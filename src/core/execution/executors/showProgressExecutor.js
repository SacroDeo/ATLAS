// src/core/execution/executors/showProgressExecutor.js
const taskQueries = require('../../../database/queries/taskQueries');
const logger = require('../../../utils/logger');

async function execute(plan, context) {
  try {
    const { user } = context;
    const today = new Date().toISOString().split('T')[0];

    const tasks = await taskQueries.getDailyTasks(user.id, today);

    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'completed').length;
    const skipped = tasks.filter(t => t.status === 'skipped').length;
    const pending = tasks.filter(t => t.status === 'pending').length;
    const rate = total > 0 ? Math.round((completed / total) * 100) : 0;

    const filled = Math.round(rate / 10);
    const bar = '🟩'.repeat(filled) + '⬜'.repeat(10 - filled);

    const streak = user.current_streak || 0;
    const longestStreak = user.longest_streak || streak;

    let message;
    if (total === 0) {
      message = `📊 *Today's Progress*\n\nNo tasks yet today. Say "generate tasks" to get started.`;
    } else {
      message = [
        `📊 *Today's Progress*`,
        ``,
        `${bar} ${rate}%`,
        ``,
        `✅ Completed: ${completed}/${total}`,
        `⏭ Skipped: ${skipped}`,
        `⏳ Remaining: ${pending}`,
        ``,
        `🔥 Current Streak: ${streak} day${streak !== 1 ? 's' : ''}`,
        `🏆 Longest Streak: ${longestStreak} day${longestStreak !== 1 ? 's' : ''}`,
      ].join('\n');
    }

    return { success: true, message };

  } catch (error) {
    logger.error('showProgressExecutor failed:', error);
    return { success: false, message: '😅 Could not fetch your progress. Try /progress instead.' };
  }
}

module.exports = { execute };