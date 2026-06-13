const { format, addDays, startOfWeek, endOfWeek, differenceInDays, parseISO } = require('date-fns');

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

  getWeekNumber() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const days = Math.floor((now - start) / (24 * 60 * 60 * 1000));
    return Math.ceil((days + start.getDay() + 1) / 7);
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