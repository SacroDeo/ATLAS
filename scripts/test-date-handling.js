// scripts/test-date-handling.js
// Unit test for BUG-001: the UTC/local split-brain in date handling.
//
// Two halves of the fix are pinned here:
//   1. timezoneUtils.getLocalDateString(tz, instant) must return the calendar
//      day in the USER'S zone — never the server's, and never a value shifted by
//      a stray .toISOString(). The classic failure is a user at 23:30 local whose
//      UTC instant has already rolled to tomorrow.
//   3. dateUtils.getWeekRange(timezone) returns the USER'S Monday-Sunday week.
//      Server-local maths handed a user west of UTC next week's range once UTC
//      had rolled into Monday, so the weekly review aggregated an empty week.
//   2. taskQueries.requireDate throws on a missing/malformed date instead of
//      silently falling back to the server's UTC day (the old `date = null`
//      default that let a write and a read disagree about what day it is).
//
// No network, no DB: a trivial fake is seeded for config/supabase so requiring
// taskQueries needs neither env vars nor a live client.

const supabasePath = require.resolve('../src/config/supabase');
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: { supabase: {} },
};

const timezoneUtils = require('../src/utils/timezoneUtils');
const { requireDate } = require('../src/database/queries/taskQueries');
const dateUtils = require('../src/utils/dateUtils');

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

// ── 1. getLocalDateString returns the user's local day, not the server's ─────
{
  // 2026-01-16T04:30:00Z is 23:30 on 2026-01-15 in New York (UTC-5 in winter).
  // The naive `toISOString().slice(0,10)` would say 2026-01-16 — tomorrow.
  const lateNightNY = new Date('2026-01-16T04:30:00Z');
  check(
    'NY 23:30 local → local day (2026-01-15), not UTC tomorrow',
    timezoneUtils.getLocalDateString('America/New_York', lateNightNY) === '2026-01-15',
    timezoneUtils.getLocalDateString('America/New_York', lateNightNY)
  );

  // Same instant, positive offset: 04:30 UTC is already 10:00 on the 16th in IST
  // (UTC+5:30). Proves the function tracks the zone, not a fixed sign.
  check(
    'IST same instant → 2026-01-16',
    timezoneUtils.getLocalDateString('Asia/Kolkata', lateNightNY) === '2026-01-16',
    timezoneUtils.getLocalDateString('Asia/Kolkata', lateNightNY)
  );

  // Early-morning UTC that is still "yesterday" in a negative zone.
  const earlyUTC = new Date('2026-03-01T02:00:00Z'); // 21:00 on 02-28 in NY
  check(
    'NY early-UTC → previous local day (2026-02-28)',
    timezoneUtils.getLocalDateString('America/New_York', earlyUTC) === '2026-02-28',
    timezoneUtils.getLocalDateString('America/New_York', earlyUTC)
  );

  // Output shape is always zero-padded YYYY-MM-DD (the shape requireDate accepts).
  check(
    'output is zero-padded YYYY-MM-DD',
    /^\d{4}-\d{2}-\d{2}$/.test(timezoneUtils.getLocalDateString('UTC', new Date('2026-07-04T00:00:00Z')))
  );

  // Missing timezone falls back to UTC rather than throwing.
  check(
    'undefined tz → UTC day',
    timezoneUtils.getLocalDateString(undefined, new Date('2026-07-04T12:00:00Z')) === '2026-07-04'
  );
}

// ── 2. getLocalDateStringDaysAgo composes on getLocalDateString ─────────────
{
  // daysAgo(0) must equal today in the same zone, and daysAgo(1) must be a
  // strictly earlier calendar day. Both are deterministic relative to now,
  // and YYYY-MM-DD strings order lexicographically.
  const todayUTC = timezoneUtils.getLocalDateString('UTC');
  check(
    'daysAgo(UTC, 0) === today (UTC)',
    timezoneUtils.getLocalDateStringDaysAgo('UTC', 0) === todayUTC,
    `${timezoneUtils.getLocalDateStringDaysAgo('UTC', 0)} vs ${todayUTC}`
  );
  check(
    'daysAgo(UTC, 1) is strictly before today',
    timezoneUtils.getLocalDateStringDaysAgo('UTC', 1) < todayUTC,
    timezoneUtils.getLocalDateStringDaysAgo('UTC', 1)
  );
}

// ── 3. requireDate throws on missing/malformed, passes a valid local day ─────
{
  const bad = [null, undefined, '', '2026-9-3', '2026-09-3', '2026/09/03', 'today', 20260903, '2026-09-03T00:00:00Z'];
  for (const v of bad) {
    let threw = false;
    try { requireDate(v, 'test'); } catch { threw = true; }
    check(`requireDate throws on ${JSON.stringify(v)}`, threw);
  }

  check('requireDate returns a valid YYYY-MM-DD unchanged', requireDate('2026-09-03', 'test') === '2026-09-03');

  // The thrown message must point the caller at the right fix, not just fail.
  let msg = '';
  try { requireDate(null, 'getDailyTasks'); } catch (e) { msg = e.message; }
  check('requireDate error names the function and the helper', /getDailyTasks/.test(msg) && /getLocalDateString/.test(msg), msg);
}

// ── 4. getWeekRange returns the USER'S week, not the server's ────────────────
{
  // Monday 02:00 UTC. In Honolulu (UTC-10) it is still Sunday 16:00, so the week
  // that just finished is Aug 31 – Sep 6. Server-local maths hands that user
  // Sep 7–13 instead: a week with no completed tasks in it, which is what made
  // the weekly review report a blank week for far-west users.
  const mondayEarlyUTC = new Date('2026-09-07T02:00:00Z');

  const hono = dateUtils.getWeekRange('Pacific/Honolulu', mondayEarlyUTC);
  check(
    'Honolulu at Mon 02:00Z → the week just finished',
    hono.start === '2026-08-31' && hono.end === '2026-09-06',
    JSON.stringify(hono)
  );

  const utc = dateUtils.getWeekRange('UTC', mondayEarlyUTC);
  check(
    'UTC at Mon 02:00Z → the new week',
    utc.start === '2026-09-07' && utc.end === '2026-09-13',
    JSON.stringify(utc)
  );

  // East of UTC agrees with UTC at this instant — proves the shift follows the
  // zone's sign rather than always subtracting a day.
  const ist = dateUtils.getWeekRange('Asia/Kolkata', mondayEarlyUTC);
  check(
    'Kolkata at Mon 02:00Z (07:30 local) → the new week',
    ist.start === '2026-09-07' && ist.end === '2026-09-13',
    JSON.stringify(ist)
  );

  // Whatever the zone, the pair is always Monday → the Sunday six days later.
  const day = s => new Date(s + 'T00:00:00Z').getUTCDay();
  check('range is Monday→Sunday', day(hono.start) === 1 && day(hono.end) === 0);

  // Omitting the timezone must keep the old server-local behaviour, so no
  // existing caller changes shape.
  const isDayString = s =>
    typeof s === 'string' && s.length === 10 && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
  const fallback = dateUtils.getWeekRange();
  check(
    'no timezone still returns a valid YYYY-MM-DD pair',
    isDayString(fallback.start) && isDayString(fallback.end),
    JSON.stringify(fallback)
  );
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\ntest-date-handling: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
console.log('  all date-handling assertions passed');
process.exit(0);
