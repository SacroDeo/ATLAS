// src/core/execution/executors/deleteTasksExecutor.js
const taskQueries = require('../../../database/queries/taskQueries');
const logger = require('../../../utils/logger');

class DeleteTasksExecutor {

  // Parses "1", "1,2,3", "1 2 3", "2, 3, 4" → [1,2,3]
  _parseNumbers(raw) {
    if (raw === null || raw === undefined) return [];
    const str = String(raw);
    const nums = str
      .split(/[\s,]+/)
      .map(n => parseInt(n.trim()))
      .filter(n => !isNaN(n) && n >= 1);
    return [...new Set(nums)]; // deduplicate
  }

  async execute(plan, context) {
    try {
      const userId = context.user.id;
      const target = plan.payload?.target;
      const rawNumbers = plan.payload?.task_number;

      const today = new Date().toISOString().split('T')[0];
      const tasks = await taskQueries.getDailyTasks(userId, today);

      if (!tasks || tasks.length === 0) {
        return { success: false, message: '📋 You have no tasks for today.' };
      }

      // ── BULK DELETE ALL ──────────────────────────────────────────
      if (target === 'all') {
        const taskIds = tasks.map(t => t.id);
        await taskQueries.deleteTasksBulk(userId, taskIds);
        return {
          success: true,
          message: `✅ Deleted all ${taskIds.length} tasks for today.`
        };
      }

      // ── MULTI OR SINGLE DELETE ───────────────────────────────────
      const numbers = this._parseNumbers(rawNumbers);

      if (numbers.length === 0) {
        return { success: false, message: '❌ Invalid task number.' };
      }

      // Validate all numbers before deleting anything
      const outOfRange = numbers.filter(n => n > tasks.length);
      if (outOfRange.length > 0) {
        return {
          success: false,
          message: `❌ Task${outOfRange.length > 1 ? 's' : ''} ${outOfRange.join(', ')} not found. You have ${tasks.length} task(s) today.`
        };
      }

      if (numbers.length === 1) {
        // Single delete — simple path
        const targetTask = tasks[numbers[0] - 1];
        await taskQueries.deleteTask(targetTask.id);
        return {
          success: true,
          message: `✅ Deleted task ${numbers[0]}: "${targetTask.title}"`
        };
      }

      // Multi delete — sort descending so position shifts don't matter,
      // collect titles BEFORE any deletion using the original snapshot
      const sorted = [...numbers].sort((a, b) => b - a);
      const deleted = [];

      for (const num of sorted) {
        // Re-fetch each time so position → id mapping is always fresh
        const currentTasks = await taskQueries.getDailyTasks(userId, today);
        if (!currentTasks[num - 1]) continue;
        const task = currentTasks[num - 1];
        await taskQueries.deleteTask(task.id);
        deleted.push(`${num}. "${task.title}"`);
      }

      if (deleted.length === 0) {
        return { success: false, message: '❌ No tasks were deleted.' };
      }

      return {
        success: true,
        message: `✅ Deleted ${deleted.length} task${deleted.length > 1 ? 's' : ''}:\n${deleted.reverse().join('\n')}`
      };

    } catch (error) {
      logger.error('DeleteTasksExecutor error:', error);
      return { success: false, message: '❌ Failed to delete task(s). Try again.' };
    }
  }
}

module.exports = new DeleteTasksExecutor();