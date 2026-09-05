// src/core/execution/taskOrdering.js
//
// Single source of truth for how today's tasks are ORDERED and NUMBERED.
//
// BUG-004: the display used to renumber each status group from 1
// (`pending` 1,2,3 / `completed` 1,2) while deleteTasksExecutor and
// updateTaskExecutor indexed into the raw `getDailyTasks` result — which is
// `created_at` order with every status interleaved. "delete task 1" could then
// destroy a completed task the user never pointed at: no confirmation, no undo.
//
// The renderer and the executors now BOTH resolve a number through this one
// function, so the position a user sees and the row an executor touches cannot
// diverge. Numbering is continuous across groups (pending first, then completed,
// then skipped) precisely because a per-group restart is what made "task 1"
// ambiguous in the first place.
//
// Ordering rule: pending → completed → skipped, each group preserving the
// incoming order (getDailyTasks already sorts by created_at ascending). A task
// with a null/absent status counts as pending — start.js already treats it that
// way, and an addressable task must never fall into an invisible gap. Any other
// status (e.g. `too_hard`, a transient state immediately replaced by a
// "(Simplified)" pending task) is intentionally excluded: it is shown by no
// renderer, so it must be addressable by no number.

function isPending(task) {
  return !task.status || task.status === 'pending';
}

/**
 * Canonical ordered list for numbering and display.
 * @param {Array} tasks - rows from taskQueries.getDailyTasks
 * @returns {Array} the same rows, ordered pending → completed → skipped
 */
function orderForNumbering(tasks) {
  const list = tasks || [];
  const pending = list.filter(isPending);
  const completed = list.filter(t => t.status === 'completed');
  const skipped = list.filter(t => t.status === 'skipped');
  return [...pending, ...completed, ...skipped];
}

/**
 * Resolve a 1-based number the user typed to the task it points at.
 * @returns {object|null} the task, or null if the number is out of range.
 */
function taskAtNumber(tasks, number) {
  const ordered = orderForNumbering(tasks);
  const i = Number(number) - 1;
  return i >= 0 && i < ordered.length ? ordered[i] : null;
}

module.exports = { orderForNumbering, taskAtNumber, isPending };
