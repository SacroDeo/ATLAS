// src/services/ai/taskAdapter.js
// Builds adaptation context for task generation.
// Integrates behavior profile + roadmap phase constraints.

const adaptationEngine = require('./adaptationEngine');
const behaviorProfileBuilder = require('./behaviorProfileBuilder');
const logger = require('../../utils/logger');

const taskAdapter = {
  async buildAdaptationContext(user) {
    logger.info(`[TaskAdapter] Building adaptation context for user ${user.telegram_id}`);

    const context = await adaptationEngine.buildContext(user);

    const behaviorProfile = behaviorProfileBuilder.build(user);

    const behaviorDirectives = [
      ...behaviorProfile.directives,
      `HARD LIMITS: max ${behaviorProfile.maxTasks} tasks, max ${behaviorProfile.maxTaskTime} min per task, difficulty cap: ${behaviorProfile.difficultyCap}`,
    ];

    if (behaviorProfile.blockedTopics.length > 0) {
      behaviorDirectives.push(`BLOCKED TOPICS: ${behaviorProfile.blockedTopics.join(', ')}. NEVER generate tasks about these.`);
    }

    if (behaviorProfile.allowedTopics.length > 0) {
      behaviorDirectives.push(`PREFERRED TOPICS: ${behaviorProfile.allowedTopics.join(', ')}. Prefer tasks within these areas.`);
    }

    if (user.roadmap_json && user.roadmap_json.phases) {
      const currentPhaseIndex = user.current_phase_index || 1;
      const currentPhase = user.roadmap_json.phases.find(
        p => p.phase_index === currentPhaseIndex
      );

      if (currentPhase) {
        behaviorDirectives.push(`CURRENT ROADMAP PHASE: ${currentPhase.phase_name} (difficulty: ${currentPhase.difficulty})`);

        if (currentPhase.allowed_topics?.length > 0) {
          behaviorDirectives.push(`PHASE ALLOWED TOPICS: ${currentPhase.allowed_topics.join(', ')}`);
        }

        if (currentPhase.blocked_topics?.length > 0) {
          behaviorDirectives.push(`PHASE BLOCKED TOPICS: ${currentPhase.blocked_topics.join(', ')}`);
        }
      }
    }

    context.directives = [...behaviorDirectives, ...context.directives];
    context.behaviorProfile = behaviorProfile;

    return context;
  },
};

module.exports = taskAdapter;