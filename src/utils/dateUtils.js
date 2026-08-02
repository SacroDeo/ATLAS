const { format, addDays, startOfWeek, endOfWeek, differenceInDays, parseISO, getISOWeek, getISOWeekYear } = require('date-fns');

const dateUtils = {
  getTodayISO() {
    return format(new Date(), 'yyyy-MM-dd');
  },

  getTomorrowISO() {
    return format(addDays(new Date(), 1), 'yyyy-MM-dd');
  },

  formatDate(date) {
    return format(new Date(date), 'MMMM d, yyyy');
  },

  getWeekRange() {
    const today = new Date();
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