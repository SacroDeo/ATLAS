// src/utils/validators.js
const CONSTANTS = require('../config/constants');

const validators = {
  validateGoal(goal) {
    if (!goal || goal.trim().length < 3) {
      return { valid: false, message: 'Your goal seems too short. Could you describe it in more detail?' };
    }
    if (goal.length > 500) {
      return { valid: false, message: 'Your goal is a bit long. Try summarizing it in 1-2 sentences.' };
    }
    return { valid: true };
  },

  validateDeadline(deadline) {
    const datePatterns = [
      /^(\d{4})-(\d{2})-(\d{2})$/,
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
      /^(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})$/i,
    ];

    const relativePatterns = [
      /(\d+)\s+(day|week|month|year)s?\s*(from now)?/i,
      /next\s+(month|year)/i,
      /in\s+(\d+)\s+(day|week|month|year)s?/i,
    ];

    if (datePatterns.some(pattern => pattern.test(deadline)) || 
        relativePatterns.some(pattern => pattern.test(deadline))) {
      return { valid: true };
    }

    return { 
      valid: false, 
      message: 'Please provide a date (e.g., "2025-03-15", "3 months from now", or "next month")' 
    };
  },

  // Normalizes a user's deadline answer into a concrete duration the roadmap
  // generator can parse (e.g. "3 months", "6 weeks"). Only two shapes are
  // accepted:
  //   1. A relative duration with a number + unit: "3 months", "in 6 weeks",
  //      "within 2 months", "45 days", "1 year".
  //   2. A full future calendar date: dd/mm/yy or dd/mm/yyyy — converted to a
  //      real duration measured from today.
  // A bare month name ("august", "by december"), a duration with no number,
  // an unparseable/past date, or anything else returns { valid: false } so the
  // caller re-asks. This closes the hole where a bare month silently became a
  // default 3-month plan.
  parseDeadline(text) {
    const raw = String(text || '').trim();
    if (!raw) return { valid: false };

    // ── Shape 2: explicit dd/mm/yy or dd/mm/yyyy date ────────────────────────
    const dateMatch = raw.match(/^(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2}|\d{4})$/);
    if (dateMatch) {
      let [, dd, mm, yy] = dateMatch;
      const day   = parseInt(dd, 10);
      const month = parseInt(mm, 10);
      let   year  = parseInt(yy, 10);
      if (yy.length === 2) year += 2000; // "27" → 2027

      if (month < 1 || month > 12 || day < 1 || day > 31) return { valid: false };

      const target = new Date(year, month - 1, day);
      // Reject impossible dates (e.g. 31/02) — Date rolls them over.
      if (
        target.getFullYear() !== year ||
        target.getMonth()    !== month - 1 ||
        target.getDate()     !== day
      ) {
        return { valid: false };
      }

      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const msDiff = target.getTime() - startOfToday.getTime();
      if (msDiff <= 0) return { valid: false }; // must be a FUTURE date

      const days = Math.round(msDiff / (1000 * 60 * 60 * 24));
      const plural = (n, unit) => `${n} ${n === 1 ? unit : unit + 's'}`;
      let duration;
      if (days < 14)        duration = plural(days, 'day');
      else if (days < 84)   duration = plural(Math.max(1, Math.round(days / 7)),   'week');
      else if (days < 730)  duration = plural(Math.max(1, Math.round(days / 30)),  'month');
      else                  duration = plural(Math.max(1, Math.round(days / 365)), 'year');

      return { valid: true, duration, days, date: target };
    }

    // ── Shape 1: relative duration (number + unit) ───────────────────────────
    const durMatch = raw.match(/(\d+)\s*(day|days|week|weeks|month|months|year|years)\b/i);
    if (durMatch) {
      const num  = parseInt(durMatch[1], 10);
      if (num < 1) return { valid: false };
      let   unit = durMatch[2].toLowerCase().replace(/s$/, ''); // → singular base
      const plural = num === 1 ? unit : `${unit}s`;             // 1 month / 3 months
      return { valid: true, duration: `${num} ${plural}` };
    }

    // Everything else — bare month names, "next month", "asap", "by summer",
    // "soon", etc. — is rejected so the caller re-asks for a concrete answer.
    return { valid: false };
  },

  validateTimeAvailable(time) {
    if (!time || time.trim().length < 3) {
      return { valid: false, message: 'Please share your daily available time (e.g., "2 hours per day" or "30 minutes")' };
    }

    const lowerTime = time.toLowerCase();
    
    const hasTimeKeyword = /\b(hour|hours|minute|minutes|min|mins)\b/i.test(lowerTime);
    
    const hasNumber = /\d+/.test(lowerTime);
    
    if (!hasTimeKeyword || !hasNumber) {
      return { 
        valid: false, 
        message: 'Please include a number with hours or minutes (e.g., "2 hours", "30 minutes", "1 hour on weekdays")' 
      };
    }

    const numberMatch = lowerTime.match(/(\d+)/);
    if (numberMatch) {
      const mainNumber = parseInt(numberMatch[1]);
      const isMinutes = /\b(min|mins|minute|minutes)\b/i.test(lowerTime);
      
      let hours = isMinutes ? mainNumber / 60 : mainNumber;
      
      if (hours > 16) {
        return { 
          valid: false, 
          message: 'That seems like a lot! Maximum daily recommendation is 16 hours. Can you be more specific about your available time?' 
        };
      }
      
      if (hours < 0.08) {
        return { 
          valid: false, 
          message: 'Even 5 minutes a day is a great start! But let\'s aim for at least 5-10 minutes to make progress.' 
        };
      }
    }

    return { valid: true };
  },

  validateStruggle(struggle) {
    if (!struggle || struggle.trim().length < 5) {
      return { valid: false, message: 'Could you elaborate a bit more on your struggle?' };
    }
    return { valid: true };
  },

  validateMotivation(motivation) {
    if (!motivation || motivation.trim().length < 5) {
      return { valid: false, message: 'Take a moment to think about why this matters. Write a bit more.' };
    }
    return { valid: true };
  },

  detectPersonality(responses) {
    const text = responses.join(' ').toLowerCase();
    
    const patterns = {
      competitive: /\b(beat|win|compete|best|top|first|ahead|faster|competitive|dominate)\b/i,
      friendly: /\b(help|people|community|together|share|support|collaborate|care|compassion)\b/i,
      analytical: /\b(understand|analyze|deep|detail|logic|system|structure|precise|exactly|methodical)\b/i,
      gamified: /\b(level|point|score|badge|achieve|milestone|progress|track|game|quest)\b/i,
    };

    let maxScore = 0;
    let detectedType = CONSTANTS.PERSONALITY_TYPES.FRIENDLY;

    Object.entries(patterns).forEach(([type, pattern]) => {
      const matches = (text.match(pattern) || []).length;
      if (matches > maxScore) {
        maxScore = matches;
        detectedType = type;
      }
    });

    return detectedType;
  },

  /**
   * FIX 13: Semantic validation for user answers.
   * Rejects low-information responses without using raw length checks.
   * Allows meaningful single-word answers like "burnout", "anxiety", "fear".
   * Returns true if the answer is low-information (should be rejected).
   */
  isLowInformationAnswer(text) {
    if (!text || typeof text !== 'string') return true;

    const normalized = text.trim().toLowerCase();

    // Empty or whitespace-only
    if (normalized.length === 0) return true;

    // One-word dismissals
    const singleWordRejects = new Set([
      'idk', 'idc', 'i don\'t know', 'i dont know', 'dont know',
      'don\'t know', 'nothing', 'maybe', 'not sure', 'n/a', 'na',
      'none', 'no', 'nah', 'nope', 'yes', 'yep', 'yeah', 'ok',
      'okay', 'k', 'fine', 'whatever', 'idunno', 'dunno'
    ]);

    if (singleWordRejects.has(normalized)) return true;

    // Repeated characters (e.g., "aaaa", ".....")
    if (/^(.)\1{3,}$/.test(normalized)) return true;

    // Only punctuation/emojis
    if (/^[\s\p{P}\p{Emoji}]+$/u.test(normalized)) return true;

    return false;
  },
  
};

module.exports = validators;