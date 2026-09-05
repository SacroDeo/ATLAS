// scripts/test-task-numbering.js
// Unit test for BUG-004: the number a user sees must resolve to the same task
// an executor acts on. taskOrdering is the single source of truth both sides
// use; this pins the ordering contract so the display and the delete/update
// executors can never drift apart again. No network — pure fixtures.

const { orderForNumbering, taskAtNumber, isPending } = require('../src/core/execution/taskOrdering');

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

// getDailyTasks returns created_at ASC. Here the two COMPLETED tasks were
// created first, so the raw list starts with completed rows — exactly the shape
// that made "delete task 1" destroy a completed task under the old code.
const tasks = [
  { id: 'c1', title: 'done A', status: 'completed', created_at: '2026-09-04T01:00:00Z' },
  { id: 'c2', title: 'done B', status: 'completed', created_at: '2026-09-04T02:00:00Z' },
  { id: 'p1', title: 'todo A', status: 'pending',   created_at: '2026-09-04T03:00:00Z' },
  { id: 'p2', title: 'todo B', status: 'pending',   created_at: '2026-09-04T04:00:00Z' },
  { id: 'p3', title: 'todo C', status: 'pending',   created_at: '2026-09-04T05:00:00Z' },
];

// ── 1. Canonical order: pending first, then completed, then skipped ─────────
{
  const ids = orderForNumbering(tasks).map(t => t.id);
  check('order = pending → completed', JSON.stringify(ids) === JSON.stringify(['p1', 'p2', 'p3', 'c1', 'c2']), ids.join(','));
}

// ── 2. THE regression: "delete task 1" hits a pending task, not completed ───
{
  const t1 = taskAtNumber(tasks, 1);
  check('task 1 → first PENDING (p1), not created-first completed (c1)', t1 && t1.id === 'p1', t1 && t1.id);
  // Prove the old raw-index behaviour would have been wrong, so this test would
  // have caught the bug: raw tasks[0] is the completed row.
  check('raw index 0 was the completed row (old bug)', tasks[0].id === 'c1');
}

// ── 3. Completed/skipped remain addressable via continuous numbering ────────
{
  check('task 4 → c1', taskAtNumber(tasks, 4)?.id === 'c1', taskAtNumber(tasks, 4)?.id);
  check('task 5 → c2', taskAtNumber(tasks, 5)?.id === 'c2', taskAtNumber(tasks, 5)?.id);
}

// ── 4. Out-of-range and junk resolve to null, never a wrong task ────────────
{
  check('task 6 (past end) → null', taskAtNumber(tasks, 6) === null);
  check('task 0 → null', taskAtNumber(tasks, 0) === null);
  check('task -1 → null', taskAtNumber(tasks, -1) === null);
  check('task NaN → null', taskAtNumber(tasks, 'abc') === null);
}

// ── 5. null status counts as pending; too_hard is excluded (invisible → ─────
//       unaddressable, matching every renderer)
{
  const mixed = [
    { id: 'x', status: 'skipped',   created_at: 't1' },
    { id: 'n', status: null,        created_at: 't2' }, // null → pending
    { id: 't', status: 'too_hard',  created_at: 't3' }, // excluded
    { id: 'c', status: 'completed', created_at: 't4' },
  ];
  const ids = orderForNumbering(mixed).map(t => t.id);
  check('null→pending, too_hard dropped: order = n,c,x', JSON.stringify(ids) === JSON.stringify(['n', 'c', 'x']), ids.join(','));
  check('too_hard is not addressable by number', orderForNumbering(mixed).every(t => t.id !== 't'));
  check('isPending(null) is true', isPending({ status: null }) === true);
  check('isPending(too_hard) is false', isPending({ status: 'too_hard' }) === false);
}

// ── 6. Empty / missing input never throws ───────────────────────────────────
{
  check('orderForNumbering([]) → []', orderForNumbering([]).length === 0);
  check('orderForNumbering(undefined) → []', orderForNumbering(undefined).length === 0);
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\ntest-task-numbering: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
console.log('  all task-numbering assertions passed');
process.exit(0);
