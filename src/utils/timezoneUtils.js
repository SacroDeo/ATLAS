const { toZonedTime, format } = require('date-fns-tz');

const cityMap = {
  'mumbai': 'Asia/Kolkata',
  'delhi': 'Asia/Kolkata',
  'bangalore': 'Asia/Kolkata',
  'bengaluru': 'Asia/Kolkata',
  'chennai': 'Asia/Kolkata',
  'hyderabad': 'Asia/Kolkata',
  'kolkata': 'Asia/Kolkata',
  'india': 'Asia/Kolkata',
  'ist': 'Asia/Kolkata',
  'dubai': 'Asia/Dubai',
  'abu dhabi': 'Asia/Dubai',
  'gst': 'Asia/Dubai',
  'london': 'Europe/London',
  'uk': 'Europe/London',
  'gmt': 'Europe/London',
  'new york': 'America/New_York',
  'est': 'America/New_York',
  'los angeles': 'America/Los_Angeles',
  'pst': 'America/Los_Angeles',
  'chicago': 'America/Chicago',
  'cst': 'America/Chicago',
  'singapore': 'Asia/Singapore',
  'sgt': 'Asia/Singapore',
  'sydney': 'Australia/Sydney',
  'aest': 'Australia/Sydney',
  'toronto': 'America/Toronto',
  'canada': 'America/Toronto',
  'berlin': 'Europe/Berlin',
  'germany': 'Europe/Berlin',
  'cet': 'Europe/Berlin',
  'paris': 'Europe/Paris',
  'france': 'Europe/Paris',
  'riyadh': 'Asia/Riyadh',
  'saudi': 'Asia/Riyadh',
  'ast': 'Asia/Riyadh',
  'cairo': 'Africa/Cairo',
  'egypt': 'Africa/Cairo',
  'nairobi': 'Africa/Nairobi',
  'kenya': 'Africa/Nairobi',
  'eat': 'Africa/Nairobi',
  'karachi': 'Asia/Karachi',
  'pakistan': 'Asia/Karachi',
  'pkt': 'Asia/Karachi',
  'dhaka': 'Asia/Dhaka',
  'bangladesh': 'Asia/Dhaka',
  'bst': 'Asia/Dhaka',
  'colombo': 'Asia/Colombo',
  'sri lanka': 'Asia/Colombo',
  'kathmandu': 'Asia/Kathmandu',
  'nepal': 'Asia/Kathmandu',
  'npt': 'Asia/Kathmandu',
  'jakarta': 'Asia/Jakarta',
  'indonesia': 'Asia/Jakarta',
  'wib': 'Asia/Jakarta',
  'manila': 'Asia/Manila',
  'philippines': 'Asia/Manila',
  'pht': 'Asia/Manila',
  'tokyo': 'Asia/Tokyo',
  'japan': 'Asia/Tokyo',
  'jst': 'Asia/Tokyo',
  'seoul': 'Asia/Seoul',
  'korea': 'Asia/Seoul',
  'kst': 'Asia/Seoul',
  'beijing': 'Asia/Shanghai',
  'shanghai': 'Asia/Shanghai',
  'china': 'Asia/Shanghai',
  'cst_china': 'Asia/Shanghai',
  'moscow': 'Europe/Moscow',
  'russia': 'Europe/Moscow',
  'msk': 'Europe/Moscow',
};

const languageToTimezone = {
  'en-IN': 'Asia/Kolkata',
  'hi': 'Asia/Kolkata',
  'en-GB': 'Europe/London',
  'en-AU': 'Australia/Sydney',
  'en-CA': 'America/Toronto',
  'de': 'Europe/Berlin',
  'fr': 'Europe/Paris',
  'ar': 'Asia/Riyadh',
  'ja': 'Asia/Tokyo',
  'ko': 'Asia/Seoul',
  'zh': 'Asia/Shanghai',
  'ru': 'Europe/Moscow',
  'pt-BR': 'America/Sao_Paulo',
  'es': 'America/Mexico_City',
  'id': 'Asia/Jakarta',
  'ms': 'Asia/Singapore',
  'th': 'Asia/Bangkok',
  'vi': 'Asia/Ho_Chi_Minh',
  'tr': 'Europe/Istanbul',
  'nl': 'Europe/Amsterdam',
  'pl': 'Europe/Warsaw',
  'uk': 'Europe/Kiev',
};

const timezoneUtils = {
  guessFromLanguageCode(languageCode) {
    if (!languageCode) return null;
    return languageToTimezone[languageCode] || null;
  },

  parseUserInput(input) {
    if (!input) return null;
    const cleaned = input.toLowerCase().trim();
    if (cityMap[cleaned]) return cityMap[cleaned];
    const utcMatch = cleaned.match(/^utc([+-]\d{1,2}(?::\d{2})?)$/);
    if (utcMatch) return `Etc/GMT${utcMatch[1].startsWith('+') ? utcMatch[1].replace('+', '-') : utcMatch[1].replace('-', '+')}`;
    for (const [key, tz] of Object.entries(cityMap)) {
      if (cleaned.includes(key)) return tz;
    }
    return null;
  },

  isValidIANA(timezone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
  },

  getTimezoneDisplayName(timezone) {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      timeZoneName: 'short',
    });
    const parts = formatter.formatToParts(now);
    const tzName = parts.find(p => p.type === 'timeZoneName')?.value || timezone;
    const offset = this.getUTCOffset(timezone);
    return `${timezone} (${tzName}, UTC${offset})`;
  },

  getUTCOffset(timezone) {
    const now = new Date();
    const utcTime = now.getTime();
    const localTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const offsetMs = localTime.getTime() - utcTime;
    const offsetHours = Math.floor(Math.abs(offsetMs) / 3600000);
    const offsetMins = Math.floor((Math.abs(offsetMs) % 3600000) / 60000);
    const sign = offsetMs >= 0 ? '+' : '-';
    return offsetMins > 0
      ? `${sign}${offsetHours}:${String(offsetMins).padStart(2, '0')}`
      : `${sign}${offsetHours}`;
  },

  // The instant is injectable (default: now) for the same reason
  // getLocalDateString takes one — week/day maths at a zone boundary cannot be
  // tested against a hardcoded new Date().
  getCurrentTimeInZone(timezone, date = new Date()) {
    return toZonedTime(date, timezone);
  },

  /**
   * The current calendar date (YYYY-MM-DD) in the given timezone.
   * NEVER derive this via toZonedTime(...).toISOString() — that is only
   * correct when the server process itself runs in UTC; on any other host
   * it shifts the date by the server's own offset.
   */
  getLocalDateString(timezone, date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  },

  /**
   * The calendar date N days before today, in the given timezone.
   */
  getLocalDateStringDaysAgo(timezone, daysAgo) {
    return this.getLocalDateString(
      timezone,
      new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
    );
  },

  /**
   * Pure calendar arithmetic on a YYYY-MM-DD string — no timezone involved,
   * because there is none to involve: the input is already a local calendar
   * day. Use this to walk backwards/forwards over days instead of subtracting
   * 24h from a timestamp and re-formatting, which repeats or skips a day
   * across a DST transition.
   */
  addDaysToDateString(dateString, delta) {
    const [y, m, d] = String(dateString).split('-').map(Number);
    // Noon UTC keeps the arithmetic away from every offset boundary.
    const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    anchor.setUTCDate(anchor.getUTCDate() + delta);
    return anchor.toISOString().split('T')[0];
  },

  /**
   * Day of week (0 = Sunday … 6 = Saturday) for a YYYY-MM-DD calendar day.
   * Also pure — no timezone, because the input is already a local day.
   */
  getDayOfWeek(dateString) {
    const [y, m, d] = String(dateString).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
  },

  /**
   * The Monday that starts the local week containing `dateString`.
   */
  startOfWeekDateString(dateString) {
    const daysSinceMonday = (this.getDayOfWeek(dateString) + 6) % 7;
    return this.addDaysToDateString(dateString, -daysSinceMonday);
  },

  formatTimeInZone(date, timezone) {
    const zoned = toZonedTime(date, timezone);
    return format(zoned, 'h:mm a', { timeZone: timezone });
  },

  /**
   * Time-of-day greeting in the USER's timezone — tasks can arrive hours
   * after the preferred slot (catch-up window), so "Good morning" at 6pm
   * reads like the bot has no idea what time it is.
   */
  getGreeting(timezone) {
    const hour = this.getCurrentTimeInZone(timezone || 'UTC').getHours();
    if (hour >= 5 && hour < 12)  return { text: 'Good morning',   emoji: '🌅' };
    if (hour >= 12 && hour < 17) return { text: 'Good afternoon', emoji: '☀️' };
    if (hour >= 17 && hour < 22) return { text: 'Good evening',   emoji: '🌆' };
    return { text: 'Hey night owl', emoji: '🌙' };
  },

  formatDateTimeInZone(date, timezone) {
    const zoned = toZonedTime(date, timezone);
    return format(zoned, 'h:mm a, MMMM d yyyy', { timeZone: timezone });
  },

 shouldSendTasksNow(user) {
  // Sensible defaults instead of silently never delivering: users who
  // somehow finished onboarding without these fields get 08:00 UTC.
  const timezone = user.timezone || 'UTC';
  const preferredTime = user.preferred_time || '08:00';

  const now = this.getCurrentTimeInZone(timezone);
  const timePart = String(preferredTime).substring(0, 5);
  let [prefHour, prefMin] = timePart.split(':').map(Number);

  // NaN GUARD: a malformed/legacy preferred_time (e.g. "" , "8am", null)
  // used to make prefHour/prefMin NaN, so every comparison below was false
  // and the user NEVER received tasks — silently, with no error. Fall back
  // to 08:00 rather than skip the user forever.
  if (!Number.isInteger(prefHour) || prefHour < 0 || prefHour > 23) prefHour = 8;
  if (!Number.isInteger(prefMin) || prefMin < 0 || prefMin > 59) prefMin = 0;

  const nowTotalMins = now.getHours() * 60 + now.getMinutes();
  const prefTotalMins = prefHour * 60 + prefMin;
  const diff = nowTotalMins - prefTotalMins;

  // Deliver any time from the preferred slot until the end of the user's
  // local day. The previous 8-hour catch-up cap (diff <= 480) meant that if
  // the process was asleep/down through a user's whole window (Render free
  // tier spins down on inactivity), they were skipped for the entire day.
  // The cron's last_tasks_sent_date + processingUsers guards make delivering
  // late idempotent, so "better late than never" is safe and never double-sends.
  return diff >= 0;
},

  parseTimeInput(input) {
    const cleaned = input.toLowerCase().trim();
    const patterns = [
      { regex: /^(\d{1,2}):(\d{2})\s*(am|pm)$/i, handler: (m) => {
        let h = parseInt(m[1]);
        const min = m[2];
        if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
        if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
        return `${String(h).padStart(2, '0')}:${min}`;
      }},
      { regex: /^(\d{1,2})\s*(am|pm)$/i, handler: (m) => {
        let h = parseInt(m[1]);
        if (m[2].toLowerCase() === 'pm' && h !== 12) h += 12;
        if (m[2].toLowerCase() === 'am' && h === 12) h = 0;
        return `${String(h).padStart(2, '0')}:00`;
      }},
      { regex: /^(\d{1,2}):(\d{2})$/, handler: (m) => {
        return `${String(parseInt(m[1])).padStart(2, '0')}:${m[2]}`;
      }},
    ];

    for (const { regex, handler } of patterns) {
      const match = cleaned.match(regex);
      if (match) return handler(match);
    }
    return null;
  },
};

module.exports = timezoneUtils;