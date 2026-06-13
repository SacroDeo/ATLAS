// src/services/ai/behaviorProfileBuilder.js
// Converts user psychology into HARD CONSTRAINTS for task generation.
// Pure code — NO AI calls, NO LLM usage.

const logger = require('../../utils/logger');

// ─── Struggle → behavioral constraint mappings ────────────────────────────────
const STRUGGLE_PROFILES = {
  overwhelmed: {
    pacing: 'slow',
    maxTasks: 2,
    maxTaskTime: 20,
    difficultyCap: 'easy',
    learningStyle: 'fundamental_first',
    preferQuickWins: true,
    avoidAdvancedTopics: true,
    burnoutSensitivity: 'high',
    preferredExplanationStyle: 'simple',
    directive: 'User feels overwhelmed. Generate very short, simple tasks. Avoid complexity. Use reassuring language.',
  },
  procrastination: {
    pacing: 'normal',
    maxTasks: 3,
    maxTaskTime: 25,
    difficultyCap: 'medium',
    learningStyle: 'implementation_first',
    preferQuickWins: true,
    avoidAdvancedTopics: false,
    burnoutSensitivity: 'medium',
    preferredExplanationStyle: 'action_oriented',
    directive: 'User struggles with procrastination. First task must be a quick win under 10 minutes. Prioritize action over theory.',
  },
  focus: {
    pacing: 'normal',
    maxTasks: 2,
    maxTaskTime: 30,
    difficultyCap: 'medium',
    learningStyle: 'single_focus',
    preferQuickWins: false,
    avoidAdvancedTopics: false,
    burnoutSensitivity: 'medium',
    preferredExplanationStyle: 'concise',
    directive: 'User loses focus easily. Generate single-focus tasks only. No multi-part tasks. Include time-boxing instructions.',
  },
  overthinking: {
    pacing: 'normal',
    maxTasks: 3,
    maxTaskTime: 30,
    difficultyCap: 'medium',
    learningStyle: 'action_first',
    preferQuickWins: true,
    avoidAdvancedTopics: false,
    burnoutSensitivity: 'low',
    preferredExplanationStyle: 'direct',
    directive: 'User overthinks. Generate action-first tasks. Avoid planning-heavy or perfectionism-reinforcing tasks. Keep instructions direct.',
  },
  burnout: {
    pacing: 'slow',
    maxTasks: 2,
    maxTaskTime: 15,
    difficultyCap: 'easy',
    learningStyle: 'recovery_first',
    preferQuickWins: true,
    avoidAdvancedTopics: true,
    burnoutSensitivity: 'high',
    preferredExplanationStyle: 'gentle',
    directive: 'User burns out quickly. Tasks must be very short with recovery spacing. Avoid intensity. Include explicit permission to rest.',
  },
  motivation: {
    pacing: 'normal',
    maxTasks: 3,
    maxTaskTime: 25,
    difficultyCap: 'medium',
    learningStyle: 'momentum_building',
    preferQuickWins: true,
    avoidAdvancedTopics: false,
    burnoutSensitivity: 'medium',
    preferredExplanationStyle: 'encouraging',
    directive: 'User struggles with motivation. Start with one very easy task to build momentum. Use encouraging, progress-focused language.',
  },
  distracted: {
    pacing: 'normal',
    maxTasks: 2,
    maxTaskTime: 25,
    difficultyCap: 'medium',
    learningStyle: 'single_focus',
    preferQuickWins: false,
    avoidAdvancedTopics: false,
    burnoutSensitivity: 'medium',
    preferredExplanationStyle: 'concise',
    directive: 'User gets distracted easily. Single-focus tasks only. Include explicit "do this one thing" framing. Avoid context switching.',
  },
  time_issues: {
    pacing: 'normal',
    maxTasks: 2,
    maxTaskTime: 20,
    difficultyCap: 'medium',
    learningStyle: 'micro_session',
    preferQuickWins: true,
    avoidAdvancedTopics: false,
    burnoutSensitivity: 'medium',
    preferredExplanationStyle: 'concise',
    directive: 'User has time constraints. Generate micro-tasks that fit in small windows. Total time must be strictly under their available time.',
  },
  dont_know_where_to_start: {
    pacing: 'slow',
    maxTasks: 2,
    maxTaskTime: 20,
    difficultyCap: 'beginner',
    learningStyle: 'guided_first',
    preferQuickWins: true,
    avoidAdvancedTopics: true,
    burnoutSensitivity: 'medium',
    preferredExplanationStyle: 'step_by_step',
    directive: 'User doesn\'t know where to start. Every task must include explicit "Step 1, Step 2, Step 3" instructions. No assumptions about prior knowledge.',
  },
};

// ─── Knowledge level → hard constraints ──────────────────────────────────────
const KNOWLEDGE_CONSTRAINTS = {
  beginner: {
    difficultyCap: 'beginner',
    blockedTopics: [
      'enterprise', 'production', 'deployment', 'optimization', 'scaling',
      'advanced architecture', 'distributed systems', 'cloud infrastructure',
      'SIEM engineering', 'detection engineering', 'advanced pipelines',
      'microservices', 'container orchestration', 'CI/CD',
      'performance tuning', 'security hardening', 'advanced',
    ],
    allowedTopics: [
      'fundamentals', 'basics', 'terminology', 'introductory',
      'beginner lab', 'guided exercise', 'step by step',
    ],
    directive: 'User is a complete beginner. NEVER use jargon without definition. Every task must start from scratch. No advanced tooling.',
  },
  basic: {
    difficultyCap: 'medium',
    blockedTopics: [
      'enterprise deployment', 'production systems', 'advanced optimization',
      'distributed architecture', 'complex pipelines',
    ],
    allowedTopics: [],
    directive: 'User has basic understanding. Introduce tools with context. Build on existing knowledge without skipping prerequisites.',
  },
  intermediate: {
    difficultyCap: 'hard',
    blockedTopics: [],
    allowedTopics: [],
    directive: 'User is intermediate. Hands-on projects are appropriate. Skip basic definitions.',
  },
  advanced: {
    difficultyCap: 'hard',
    blockedTopics: [],
    allowedTopics: [],
    directive: 'User is advanced. Skip fundamentals. Focus on mastery, optimization, and real-world application.',
  },
};

// ─── Available time → constraints ────────────────────────────────────────────
function deriveTimeConstraints(availableTime) {
  if (!availableTime) return { maxTasks: 3, maxTaskTime: 35 };

  const lower = availableTime.toLowerCase();
  const hourMatch = lower.match(/(\d+)\s*hour/i);
  const minMatch = lower.match(/(\d+)\s*min/i);

  let minutes = 60; // default

  if (hourMatch) minutes = parseInt(hourMatch[1]) * 60;
  if (minMatch) minutes = parseInt(minMatch[1]);

  if (minutes <= 20) return { maxTasks: 1, maxTaskTime: minutes };
  if (minutes <= 45) return { maxTasks: 2, maxTaskTime: Math.floor(minutes / 2) };
  if (minutes <= 90) return { maxTasks: 3, maxTaskTime: Math.floor(minutes / 3) };
  return { maxTasks: 4, maxTaskTime: Math.floor(minutes / 4) };
}

// ─── Main builder ────────────────────────────────────────────────────────────

const behaviorProfileBuilder = {
  /**
   * Builds a behavior profile from user psychology.
   * Returns HARD CONSTRAINTS for roadmap + task generation.
   *
   * @param {Object} user - Full user row from DB
   * @returns {Object}     - Behavior profile with constraints and directives
   */
  build(user) {
    const profile = {
      pacing: 'normal',
      maxTasks: 3,
      maxTaskTime: 35,
      difficultyCap: 'medium',
      learningStyle: 'balanced',
      preferQuickWins: false,
      avoidAdvancedTopics: false,
      burnoutSensitivity: 'medium',
      preferredExplanationStyle: 'balanced',
      blockedTopics: [],
      allowedTopics: [],
      directives: [],
    };

    // ── Apply struggle profile ───────────────────────────────────────────────
    const struggle = (user.biggest_struggle || '').toLowerCase();
    let matchedStruggle = null;

    if (struggle.includes('overwhelm') || struggle.includes('too much') || struggle.includes('stress')) {
      matchedStruggle = 'overwhelmed';
    } else if (struggle.includes('procrastinat') || struggle.includes('put off') || struggle.includes('delay')) {
      matchedStruggle = 'procrastination';
    } else if (struggle.includes('focus') || struggle.includes('distract') || struggle.includes('concentrat')) {
      matchedStruggle = 'focus';
    } else if (struggle.includes('overthink') || struggle.includes('perfect')) {
      matchedStruggle = 'overthinking';
    } else if (struggle.includes('burnout') || struggle.includes('burn out') || struggle.includes('exhaust')) {
      matchedStruggle = 'burnout';
    } else if (struggle.includes('motivation') || struggle.includes('motivated') || struggle.includes('lazy')) {
      matchedStruggle = 'motivation';
    } else if (struggle.includes('distract') || struggle.includes('phone') || struggle.includes('social media')) {
      matchedStruggle = 'distracted';
    } else if (struggle.includes('time') || struggle.includes('busy') || struggle.includes('schedule')) {
      matchedStruggle = 'time_issues';
    } else if (struggle.includes('don\'t know where') || struggle.includes('start') || struggle.includes('lost')) {
      matchedStruggle = 'dont_know_where_to_start';
    }

    if (matchedStruggle && STRUGGLE_PROFILES[matchedStruggle]) {
      const sp = STRUGGLE_PROFILES[matchedStruggle];
      Object.assign(profile, {
        pacing: sp.pacing,
        maxTasks: sp.maxTasks,
        maxTaskTime: sp.maxTaskTime,
        difficultyCap: sp.difficultyCap,
        learningStyle: sp.learningStyle,
        preferQuickWins: sp.preferQuickWins,
        avoidAdvancedTopics: sp.avoidAdvancedTopics,
        burnoutSensitivity: sp.burnoutSensitivity,
        preferredExplanationStyle: sp.preferredExplanationStyle,
      });
      profile.directives.push(sp.directive);
    }

    // ── Apply knowledge constraints (OVERRIDE struggle where knowledge is more restrictive) ──
    const knowledge = (user.domain_knowledge || 'beginner').toLowerCase();
    const kc = KNOWLEDGE_CONSTRAINTS[knowledge] || KNOWLEDGE_CONSTRAINTS.beginner;

    // Knowledge level difficulty cap overrides struggle if more restrictive
    const difficultyOrder = {
  easy: 0,
  medium: 1,
  hard: 2
};
    const knowledgeDifficulty = kc.difficultyCap;
    const struggleDifficulty = profile.difficultyCap;

    if ((difficultyOrder[knowledgeDifficulty] ?? 2) < (difficultyOrder[struggleDifficulty] ?? 2)) {
      profile.difficultyCap = knowledgeDifficulty;
    }

    profile.blockedTopics = [...new Set([...profile.blockedTopics, ...kc.blockedTopics])];
    profile.allowedTopics = [...new Set([...profile.allowedTopics, ...kc.allowedTopics])];
    profile.directives.push(kc.directive);

    // ── Apply time constraints ───────────────────────────────────────────────
    const timeConstraints = deriveTimeConstraints(user.available_time);
    profile.maxTasks = Math.min(profile.maxTasks, timeConstraints.maxTasks);
    profile.maxTaskTime = Math.min(profile.maxTaskTime, timeConstraints.maxTaskTime);
    profile.directives.push(
      `User has ${user.available_time || 'limited time'} available. Total task time must fit within this window.`
    );

    // ── Life struggle context ────────────────────────────────────────────────
    if (user.life_struggle) {
      profile.directives.push(
        `User is dealing with: ${user.life_struggle} — avoid tasks that require long uninterrupted focus blocks.`
      );
    }

    // Ensure minimum directives
    if (profile.directives.length === 0) {
      profile.directives.push('Generate balanced tasks aligned to the user\'s current roadmap phase.');
    }

    logger.info(
      `[BehaviorProfile] User ${user.telegram_id}: ` +
      `pacing=${profile.pacing}, maxTasks=${profile.maxTasks}, ` +
      `difficultyCap=${profile.difficultyCap}, struggle=${matchedStruggle || 'none'}, ` +
      `knowledge=${knowledge}`
    );

    return profile;
  },
};

module.exports = behaviorProfileBuilder;