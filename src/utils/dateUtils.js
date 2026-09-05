const { format, startOfWeek, endOfWeek, differenceInDays, parseISO, getISOWeek, getISOWeekYear } = require('date-fns');
const timezoneUtils = require('./timezoneUtils');

const dateUtils = {
  formatDate(date) {
    return format(new Date(date), 'MMMM d, yyyy');
  },

  // Monday-anchored week containing "now", in the user's timezone when one is
  // given. Without it this falls back to server time, which on Render is UTC:
  // for a user west of UTC, once UTC had rolled into Monday this returned NEXT
  // week's range, so the weekly review aggregated the wrong seven days of tasks.
  // format() reads local getters, so a zoned Date must not be .toISOString()'d
  // on the way here — that is the BUG-001 trap.
  getWeekRange(timezone, now = new Date()) {
    const today = timezone
      ? timezoneUtils.getCurrentTimeInZone(timezone, now)
      : now;
    return {
      start: format(startOfWeek(today, { weekStartsOn: 1 }), 'yyyy-MM-dd'),
      end: format(endOfWeek(today, { weekStartsOn: 1 }), 'yyyy-MM-dd'),
    };
  },

  // Year-qualified ISO week number as an integer YYYYWW, e.g. 202601.
  // Two reasons for the year prefix:
  //   1) The weekly_reviews table is UNIQUE(user_id, week_number) with no
  //      separate year column. A bare 1..53 would make Jan's week 1 collide
  //      with last year's week 1 — the dedup lookup would find the stale row
  //      and silently skip the user's first reviews of every new year.
  //   2) Uses ISO week (Monday-anchored) to stay consistent with
  //      getWeekRange(), which is weekStartsOn:1 — the review's week label
  //      and its date range must not disagree at week boundaries.
  // getISOWeekYear (not getFullYear) is deliberate: for a date in the first
  // days of January that ISO-belongs to the previous year's last week, it
  // returns that previous year, keeping the pairing correct.
  // Deliberately NOT timezone-aware, unlike getWeekRange(timezone) above. This
  // value is the dedup key: weekly_reviews is UNIQUE(user_id, week_number) and
  // weeklyCron derives one shared guard key per tick from it. Making it per-user
  // would change what is already stored and require reworking that guard, so a
  // far-west user's label can still read one week ahead of their range. Wrong
  // label, right data — fix the label with the weeklyCron guard, together.
  getWeekNumber() {
    const now = new Date();
    return getISOWeekYear(now) * 100 + getISOWeek(now);
  },

  daysBetween(date1, date2) {
    return differenceInDays(parseISO(date1), parseISO(date2));
  },

  isWeekend(date) {
    const day = new Date(date).getDay();
    return day === 0 || day === 6;
  },
};

module.exports = dateUtils;