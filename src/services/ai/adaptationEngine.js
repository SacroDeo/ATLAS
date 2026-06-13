// src/services/ai/adaptationEngine.js
// Pure code — NO AI calls.
// Consumes an engagementSnapshot + user record and outputs adaptation directives
// that are injected into dailyTaskGenerator BEFORE the AI prompt is built.

const engagementAnalyzer = require('../accountability/engagementAnalyzer');
const logger = require('../../utils/logger');

// ─── Difficulty Mapping ───────────────────────────────────────────────────────

const DIFFICULTY_MAP = {
  lower: { label: 'easy', maxMinutes: 20, taskStyle: 'momentum' },
  same:  { label: 'medium', maxMinutes: 35, taskStyle: 'balanced' },
  higher: { label: 'hard', maxMinutes: 50, taskStyle: 'challenge' },
};

// ─── Engine ───────────────────────────────────────────────────────────────────

const adaptationEngine = {
  /**
   * Build a full adaptation context for a user before task generation.
   * This is the ONLY function dailyTaskGenerator needs to call.
   *
   * @param {Object} user   - Full user row from DB
   * @returns {Object}      - Adaptation context (see schema below)
   */
  async buildContext(user) {
    try {
      const snapshot = await engagementAnalyzer.analyze(user);
      const context = this._derive(snapshot, user);

      logger.info(
        `[AdaptationEngine] User ${user.telegram_id}: ` +
        `difficulty=${context.difficulty}, pacing=${context.pacing}, ` +
        `emotionalState=${context.emotionalState}, directives=${context.directives.length}`
      );

      return context;
    } catch (error) {
      logger.error(`[AdaptationEngine] Failed for user ${user.telegram_id}:`, error);
      return this._defaultContext();
    }
  },

  // ─── Core Derivation ──────────────────────────────────────────────────────

  _derive(snapshot, user) {
    const difficulty = this._deriveDifficulty(snapshot);
    const pacing = this._derivePacing(snapshot);
    const emotionalState = this._deriveEmotionalState(snapshot);
    const maxTaskDuration = DIFFICULTY_MAP[difficulty].maxMinutes;
    const preferredTaskStyle = DIFFICULTY_MAP[difficulty].taskStyle;
    const directives = this._buildDirectives(snapshot, difficulty, emotionalState, user);

    return {
      difficulty,                    // 'lower' | 'same' | 'higher'
      pacing,                        // 'slow' | 'normal' | 'accelerated'
      maxTaskDuration,               // integer minutes
      preferredTaskStyle,            // 'momentum' | 'balanced' | 'challenge'
      emotionalState,                // 'overwhelmed' | 'recovering' | 'stable' | 'motivated'
      burnoutRisk: snapshot.burnoutRisk,
      consistencyTrend: snapshot.consistencyTrend,
      directives,                    // string[] — injected verbatim into the AI prompt
      // Pass-through for callers that want raw data
      _snapshot: snapshot,
    };
  },

  // ─── Difficulty ─────────────────────────────────────────────────────────────

  _deriveDifficulty(snapshot) {
    // Explicit overwhelm signals → lower difficulty
    if (
      snapshot.burnoutRisk === 'high' ||
      snapshot.tooHardRate > 0.4 ||
      snapshot.overwhelmScore > 0.6
    ) {
      return 'lower';
    }

    // Disengaged / inactive → lower difficulty to rebuild habit
    if (
      snapshot.engagementLevel === 'disengaged' ||
      snapshot.motivationState === 'collapsed'
    ) {
      return 'lower';
    }

    // Declining trend with moderate skip → lower
    if (snapshot.consistencyTrend === 'dropping' && snapshot.skipRate > 0.3) {
      return 'lower';
    }

    // High engagement, improving trend → push harder
    if (
      snapshot.engagementLevel === 'high' &&
      snapshot.consistencyTrend === 'improving' &&
      snapshot.burnoutRisk === 'low'
    ) {
      return 'higher';
    }

    return 'same';
  },

  // ─── Pacing ─────────────────────────────────────────────────────────────────

  _derivePacing(snapshot) {
    if (
      snapshot.burnoutRisk === 'high' ||
      snapshot.motivationState === 'collapsed' ||
      snapshot.inactivityHours > 48
    ) {
      return 'slow';
    }

    if (
      snapshot.engagementLevel === 'high' &&
      snapshot.consistencyTrend === 'improving'
    ) {
      return 'accelerated';
    }

    return 'normal';
  },

  // ─── Emotional State ────────────────────────────────────────────────────────

  _deriveEmotionalState(snapshot) {
    if (snapshot.burnoutRisk === 'high' || snapshot.overwhelmScore > 0.6) {
      return 'overwhelmed';
    }
    if (
      snapshot.motivationState === 'collapsed' ||
      snapshot.engagementLevel === 'disengaged'
    ) {
      return 'recovering';
    }
    if (
      snapshot.engagementLevel === 'high' &&
      snapshot.motivationState === 'strong'
    ) {
      return 'motivated';
    }
    return 'stable';
  },

  // ─── Directive Builder ──────────────────────────────────────────────────────

  /**
   * Builds a deterministic list of plain-English directives.
   * These are injected directly into the task generation AI prompt.
   */
  _buildDirectives(snapshot, difficulty, emotionalState, user) {
    const directives = [];

    // ── Difficulty directives ──
    if (difficulty === 'lower') {
      directives.push('Generate shorter, easier tasks that can be completed in under 20 minutes');
      directives.push('Avoid cognitively heavy or multi-step tasks');
      directives.push('Prioritize quick wins to rebuild momentum');
    } else if (difficulty === 'higher') {
      directives.push('Include at least one challenging, skill-stretching task');
      directives.push('User is in peak performance mode — push for depth over breadth');
    }

    // ── Pacing directives ──
    if (snapshot.burnoutRisk === 'high') {
      directives.push('Reduce total task count to 2 tasks maximum today');
      directives.push('Focus on one core skill area only — avoid context switching');
    } else if (snapshot.pacing === 'slow' || emotionalState === 'recovering') {
      directives.push('Keep total session time under 45 minutes across all tasks');
    }

    // ── Overwhelm directives ──
    if (snapshot.tooHardRate > 0.3) {
      directives.push(`User marked ${Math.round(snapshot.tooHardRate * 100)}% of recent tasks as too hard — significantly reduce task complexity`);
    }

    if (snapshot.overwhelmScore > 0.5) {
      directives.push('User is showing overwhelm signals — use simple, clear language in task descriptions');
      directives.push('Break down any multi-part tasks into the smallest executable unit');
    }

    // ── Inactivity directives ──
    if (snapshot.inactivityHours > 48) {
      directives.push('User has been inactive for 2+ days — start with one very easy re-entry task');
      directives.push('First task must be completable in under 10 minutes to re-establish momentum');
    }

    // ── Streak protection ──
    if (snapshot.streakRisk === 'high' || snapshot.streakRisk === 'critical') {
      directives.push('Streak is at risk — at least one task must be achievable in under 15 minutes regardless of other constraints');
    }

    // ── Consistency directives ──
    if (snapshot.consistencyTrend === 'dropping') {
      directives.push('Completion rate is declining — vary task types to re-engage interest');
      directives.push('Include at least one task the user has historically succeeded at');
    } else if (snapshot.consistencyTrend === 'improving') {
      directives.push('User is building momentum — maintain positive reinforcement in task framing');
    }

    // ── Emotional state directives ──
    if (emotionalState === 'overwhelmed') {
      directives.push('Frame all tasks as small, manageable steps — avoid ambitious scope');
      directives.push('Do not include any deadline pressure in task descriptions');
    } else if (emotionalState === 'motivated') {
      directives.push('User is motivated — frame tasks with growth and achievement language');
    } else if (emotionalState === 'recovering') {
      directives.push('User is returning after a break — be encouraging, not pressuring, in task framing');
    }

    // ── Life struggle context ──
    if (user.life_struggle) {
      directives.push(`User is dealing with: ${user.life_struggle} — avoid tasks that require long uninterrupted focus blocks`);
    }

    // ── Knowledge level ──
    if (user.domain_knowledge === 'beginner') {
      directives.push('User is a beginner — avoid jargon and ensure every task has clear step-by-step instructions');
    } else if (user.domain_knowledge === 'advanced') {
      directives.push('User has advanced knowledge — skip basics and focus on applied, real-world tasks');
    }

    // ── Available time ──
    if (user.available_time) {
      directives.push(`User has ${user.available_time} available today — total task time must fit within this window`);
    }

    // Always include at minimum one directive
    if (directives.length === 0) {
      directives.push('Generate 3 balanced tasks aligned to the user\'s current roadmap phase');
    }

    return directives;
  },

  // ─── Default Context ────────────────────────────────────────────────────────

  _defaultContext() {
    return {
      difficulty: 'same',
      pacing: 'normal',
      maxTaskDuration: 35,
      preferredTaskStyle: 'balanced',
      emotionalState: 'stable',
      burnoutRisk: 'low',
      consistencyTrend: 'insufficient_data',
      directives: ['Generate 3 balanced tasks aligned to the user\'s current roadmap phase'],
      _snapshot: null,
    };
  },
};

module.exports = adaptationEngine;