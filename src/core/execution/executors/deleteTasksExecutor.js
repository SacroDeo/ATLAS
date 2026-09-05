// src/core/execution/executors/deleteTasksExecutor.js
const taskQueries = require('../../../database/queries/taskQueries');
const timezoneUtils = require('../../../utils/timezoneUtils');
const logger = require('../../../utils/logger');
const { orderForNumbering } = require('../taskOrdering');

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

      const today = timezoneUtils.getLocalDateString(context.user.timezone || 'UTC');
      const tasks = await taskQueries.getDailyTasks(userId, today);

      if (!tasks || tasks.length === 0) {
        return { success: false, message: '📋 You have no tasks for today.' };
      }

      // ── BULK DELETE ALL ──────────────────────────────────────────
      if (target === 'all') {
        const taskIds = tasks.map(t => t.id);
        // deleteTasksBulk swallows its own error and returns false — if we
        // don't check it we'd claim success while nothing was deleted (BUG-013).
        const ok = await taskQueries.deleteTasksBulk(userId, taskIds);
        if (!ok) {
          return { success: false, message: '❌ Failed to delete your tasks. Try again.' };
        }
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

      // Resolve numbers against the SAME order the user saw (taskOrdering),
      // never the raw created_at list — that mismatch is BUG-004.
      const ordered = orderForNumbering(tasks);

      // Validate all numbers before deleting anything
      const outOfRange = numbers.filter(n => n > ordered.length);
      if (outOfRange.length > 0) {
        return {
          success: false,
          message: `❌ Task${outOfRange.length > 1 ? 's' : ''} ${outOfRange.join(', ')} not found. You have ${ordered.length} task(s) today.`
        };
      }

      if (numbers.length === 1) {
        // Single delete — simple path
        const targetTask = ordered[numbers[0] - 1];
        await taskQueries.deleteTask(targetTask.id, userId);
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
        // Re-fetch AND re-order each time so position → id mapping stays fresh
        // and keeps matching the numbering the user acted on.
        const currentOrdered = orderForNumbering(await taskQueries.getDailyTasks(userId, today));
        if (!currentOrdered[num - 1]) continue;
        const task = currentOrdered[num - 1];
        await taskQueries.deleteTask(task.id, userId);
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