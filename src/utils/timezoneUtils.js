const { toZonedTime, fromZonedTime, format } = require('date-fns-tz');

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

  userTimeToUTC(timeString, timezone) {
    const today = new Date().toISOString().split('T')[0];
    const localDateTime = `${today}T${timeString}:00`;
    return fromZonedTime(localDateTime, timezone);
  },

  getCurrentTimeInZone(timezone) {
    return toZonedTime(new Date(), timezone);
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

  formatTimeInZone(date, timezone) {
    const zoned = toZonedTime(date, timezone);
    return format(zoned, 'h:mm a', { timeZone: timezone });
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
  const [prefHour, prefMin] = timePart.split(':').map(Number);

  const nowHour = now.getHours();
  const nowMin = now.getMinutes();

  const nowTotalMins = nowHour * 60 + nowMin;
  const prefTotalMins = prefHour * 60 + prefMin;
  const diff = nowTotalMins - prefTotalMins;

  // Within 30-minute delivery window after preferred time
  if (diff >= 0 && diff <= 30) return true;

  // CATCH-UP: If preferred time has passed today (up to 8 hours late),
  // still send — last_tasks_sent_date check in cron prevents double send
  if (diff > 30 && diff <= 480) return true;

  return false;
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