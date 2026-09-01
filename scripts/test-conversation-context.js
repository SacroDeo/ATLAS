// scripts/test-conversation-context.js
// Unit test: conversationContext.build — role separation, recall honesty,
// duplicate-live-message suppression, gap phrasing. No network, no DB.
const ctx = require('../src/services/ai/conversationContext');

const id = (v) => String(v == null ? '' : v);
let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

const NOW = new Date('2026-09-01T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

// ── 1. Empty history must state plainly there is no past ────────────────────
{
  const r = ctx.build([], id, { now: NOW });
  check('empty: no turns', r.turns.length === 0);
  check('empty: says first contact', /first thing/i.test(r.recall));
  check('empty: forbids inventing', /never invent/i.test(r.recall));
}

// ── 2. Roles are preserved and normalized ───────────────────────────────────
{
  const h = [
    { role: 'user', content: 'hey', created_at: ago(10 * MIN) },
    { role: 'assistant', content: 'Hey! What is up?', created_at: ago(9 * MIN) },
    { role: 'weird', content: 'unknown role', created_at: ago(8 * MIN) },
  ];
  const r = ctx.build(h, id, { now: NOW });
  check('roles: 3 turns', r.turns.length === 3, `got ${r.turns.length}`);
  check('roles: user kept', r.turns[0].role === 'user');
  check('roles: assistant kept', r.turns[1].role === 'assistant');
  check('roles: unknown → user', r.turns[2].role === 'user');
}

// ── 3. Empty / malformed rows dropped ───────────────────────────────────────
{
  const h = [
    { role: 'user', content: '   ', created_at: ago(5 * MIN) },
    null,
    { role: 'user', content: 'real', created_at: ago(4 * MIN) },
    { role: 'assistant', content: null, created_at: ago(3 * MIN) },
  ];
  const r = ctx.build(h, id, { now: NOW });
  check('malformed: only real row', r.turns.length === 1 && r.turns[0].content === 'real');
}

// ── 4. maxTurns keeps the MOST RECENT turns ─────────────────────────────────
{
  const h = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `msg${i}`,
    created_at: ago((30 - i) * MIN),
  }));
  const r = ctx.build(h, id, { now: NOW, maxTurns: 12 });
  check('window: capped at 12', r.turns.length === 12, `got ${r.turns.length}`);
  check('window: newest kept', r.turns[11].content === 'msg29');
  check('window: oldest dropped', !r.turns.some(t => t.content === 'msg0'));
  check('window: states count', /last 12 turns/.test(r.recall), r.recall);}

// ── 5. Duplicate live message is not shown twice ────────────────────────────
{
  const h = [
    { role: 'user', content: 'earlier thing', created_at: ago(20 * MIN) },
    { role: 'assistant', content: 'sure', created_at: ago(19 * MIN) },
    { role: 'user', content: 'can we talk?', created_at: ago(1000) },
  ];
  const dedup = ctx.build(h, id, { now: NOW, liveMessage: 'can we talk?' });
  check('dedup: live row removed', dedup.turns.length === 2, `got ${dedup.turns.length}`);
  check('dedup: last is assistant', dedup.turns[1].role === 'assistant');

  const kept = ctx.build(h, id, { now: NOW, liveMessage: 'something else' });
  check('dedup: non-match keeps all', kept.turns.length === 3);

  // Must not strip an assistant row that happens to equal the live text.
  const h2 = [{ role: 'assistant', content: 'same text', created_at: ago(MIN) }];
  const r2 = ctx.build(h2, id, { now: NOW, liveMessage: 'same text' });
  check('dedup: assistant row safe', r2.turns.length === 1);
}

// ── 6. Gap phrasing matches how a person would say it ───────────────────────
{
  const cases = [
    [30 * 1000, /seconds ago/],
    [1 * MIN, /a minute ago/],
    [12 * MIN, /about 12 minutes ago/],
    [1 * HOUR, /about an hour ago/],
    [5 * HOUR, /about 5 hours ago/],
    [1 * DAY, /yesterday/],
    [3 * DAY, /3 days ago/],
    [9 * DAY, /about a week ago/],
    [30 * DAY, /about 4 weeks ago/],
    [90 * DAY, /about 3 months ago/],
  ];
  for (const [gap, re] of cases) {
    const r = ctx.build(
      [{ role: 'user', content: 'x', created_at: ago(gap) }],
      id,
      { now: NOW }
    );
    check(`gap ${gap}ms → ${re}`, re.test(r.recall), r.recall);
  }
}

// ── 7. Missing/invalid timestamp degrades honestly, never crashes ───────────
{
  const r = ctx.build([{ role: 'user', content: 'x' }], id, { now: NOW });
  check('no timestamp: admits not knowing', /do not know exactly when/i.test(r.recall), r.recall);

  const bad = ctx.build([{ role: 'user', content: 'x', created_at: 'garbage' }], id, { now: NOW });
  check('bad timestamp: no crash', typeof bad.recall === 'string');
}

// ── 8. Recall always bounds what can be known ───────────────────────────────
{
  const r = ctx.build(
    [{ role: 'user', content: 'x', created_at: ago(HOUR) }],
    id,
    { now: NOW }
  );
  check('recall: claims the window as memory', /ARE your memory/.test(r.recall), r.recall);
  check('recall: states the limit', /genuinely gone/i.test(r.recall), r.recall);
  check('recall: forbids guessing', /rather than guessing/i.test(r.recall));
}

// ── 9. Sanitizer is actually applied to stored content ──────────────────────
{
  const spy = (v) => `[S]${v}`;
  const r = ctx.build(
    [{ role: 'user', content: 'raw', created_at: ago(MIN) }],
    spy,
    { now: NOW }
  );
  check('sanitize: applied', r.turns[0].content === '[S]raw', r.turns[0].content);
}

// ── 10. Non-array input never throws ────────────────────────────────────────
{
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    const r = ctx.build(bad, id, { now: NOW });
    check(`garbage input ${JSON.stringify(bad)}`, r.turns.length === 0 && !!r.recall);
  }
}

console.log(`\nContext: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('✅ All context assertions passed');
