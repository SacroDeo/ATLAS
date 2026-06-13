const CONSTANTS = {
  PERSONALITY_TYPES: {
    COMPETITIVE: 'competitive',
    FRIENDLY: 'friendly',
    ANALYTICAL: 'analytical',
    GAMIFIED: 'gamified',
  },

  TASK_STATUS: {
    PENDING: 'pending',
    COMPLETED: 'completed',
    SKIPPED: 'skipped',
    TOO_HARD: 'too_hard',
    IN_PROGRESS: 'in_progress',
  },

  ONBOARDING_STATES: {
  GOAL: 'goal',
  MOTIVATION: 'motivation',
  DEADLINE: 'deadline',
  AVAILABLE_TIME: 'available_time',
  STRUGGLE: 'struggle',
  DOMAIN_KNOWLEDGE: 'domain_knowledge',
  START_DATE: 'start_date',
  PREFERRED_TIME: 'preferred_time',
  TIMEZONE: 'timezone',
  CONFIRMATION: 'confirmation',
  COMPLETED: 'completed',
},

  CHECKIN_TYPES: {
    DAILY: 'daily',
    SOCRATIC: 'socratic',
    STUCK: 'stuck',
  },

  SKIP_REASONS: [
    'no_time',
    'too_difficult',
    'not_relevant',
    'personal_emergency',
    'lost_motivation',
  ],

  STREAK_THRESHOLDS: {
    CONSECUTIVE_MISSES_BEFORE_CHECKIN: 3,
    MIN_TASKS_FOR_REVIEW: 5,
  },

  MEMORY_COMPRESSION: {
    MAX_TOKENS: 500,
    SUMMARY_INTERVAL_DAYS: 7,
  },
};

module.exports = CONSTANTS;