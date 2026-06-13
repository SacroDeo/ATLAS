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