// src/services/ai/dailyTaskGenerator.js
const aiOrchestrator = require('./aiOrchestrator');
const userQueries = require('../../database/queries/userQueries');
const taskQueries = require('../../database/queries/taskQueries');
const memoryService = require('../memory/memoryService');
const taskAdapter = require('./taskAdapter');
const roadmapUtils = require('../../utils/roadmapUtils');
const logger = require('../../utils/logger');



function normalizeTopic(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


class DailyTaskGenerator {
  async generateTasksForUser(telegramId) {
    const today = new Date().toISOString().split('T')[0];
    return this.generateTasksForDate(telegramId, today);
  }

  async generateTasksForDate(telegramId, date) {
    try {
      const user = await userQueries.getUserByTelegramId(telegramId);
      if (!user || !user.onboarding_completed) {
        logger.warn(`User ${telegramId} not fully onboarded`);
        return null;
      }

      const existingTasks = await taskQueries.getDailyTasks(user.id, date);
      if (existingTasks.length >= 1) {
        logger.info(`Tasks already exist for user ${telegramId} on ${date}`);
        return existingTasks;
      }

      // ── STEP 1: Build behavior profile (HARD CONSTRAINTS) ──────────────────
      const behaviorProfileBuilder = require('./behaviorProfileBuilder');
      const behaviorProfile = behaviorProfileBuilder.build(user);
      logger.info(`[DailyTaskGenerator] Behavior profile: pacing=${behaviorProfile.pacing}, maxTasks=${behaviorProfile.maxTasks}, difficultyCap=${behaviorProfile.difficultyCap}`);

      // ── STEP 2: Build adaptation context (adds behavioral + phase directives) ──
      logger.info(`Building adaptation context for user ${telegramId}`);
      const adaptation = await taskAdapter.buildAdaptationContext(user);

      // ── STEP 3: Load roadmap phase constraints ─────────────────────────────
      let phaseConstraints = null;
      {
        // Phase index lives inside roadmap_json — see roadmapUtils.
        const currentPhase = roadmapUtils.getCurrentPhase(user);
        if (currentPhase) {
          phaseConstraints = {
            phase_name: currentPhase.phase_name,
            difficulty: currentPhase.difficulty || 'medium',
            allowed_topics: currentPhase.allowed_topics || [],
            blocked_topics: currentPhase.blocked_topics || [],
            completion_requirements: currentPhase.completion_requirements || [],
          };
        }
      }

      // ── STEP 4: Merge behavior profile directives with adaptation directives ──
      const allDirectives = [
        ...behaviorProfile.directives,
        `HARD LIMITS: max ${behaviorProfile.maxTasks} tasks, max ${behaviorProfile.maxTaskTime} min per task, difficulty cap: ${behaviorProfile.difficultyCap}`,
        `BLOCKED TOPICS: ${behaviorProfile.blockedTopics.join(', ') || 'none'}`,
        `ALLOWED TOPICS: ${behaviorProfile.allowedTopics.join(', ') || 'all appropriate topics'}`,
        ...adaptation.directives,
      ];

      const conversationEngine = require('../ai/conversationEngine');

      const recentHistory = await conversationEngine.getHistory(user.id, 10);
      const lastUserMessages = recentHistory
        .filter(m => m.role === 'user')
        .slice(-5)
        .map(m => m.content);
      const manualTaskHistory = await taskQueries.getRecentManualTaskTitles(user.id, 30);
      const daysSinceStart = Math.floor(
        (Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24)
      );
      const roadmapPhase = daysSinceStart < 30
        ? 'Month 1 — Foundations'
        : daysSinceStart < 60
        ? 'Month 2 — Core Skills'
        : 'Month 3 — Practice & Application';

      const structuredContext = {
        active_goal: user.goal,
        focus_area: null,
        existing_task_titles: [],
        effective_time: user.available_time,
      };

      const enrichedUser = {
        ...user,
        domain_knowledge: user.domain_knowledge || null,
        biggest_struggle: user.biggest_struggle || null,
        life_struggle: user.life_struggle || null,
        roadmap: user.roadmap || null,
        _roadmap_phase: roadmapPhase,
        _recent_messages: lastUserMessages.join('\n') || null,
        _manual_task_history: manualTaskHistory,
        _adaptation: { ...adaptation, directives: allDirectives },
        _phase_constraints: phaseConstraints,
        _behavior_profile: behaviorProfile,
      };

      logger.info(`Generating tasks with ${allDirectives.length} combined directives`);
      const generatedData = await conversationEngine.generateTasksFromContext(
        structuredContext,
        enrichedUser
      );

      let validatedTasks = this.validateAndFormatTasks(generatedData.tasks || []);

      // ── STEP 5: Enforce hard limits ────────────────────────────────────────
      if (validatedTasks.length > behaviorProfile.maxTasks) {
        validatedTasks = validatedTasks.slice(0, behaviorProfile.maxTasks);
      }

      const blockedLower = [
        ...behaviorProfile.blockedTopics.map(t => t.toLowerCase()),
        ...(phaseConstraints?.blocked_topics || []).map(t => t.toLowerCase()),
      ];
      if (blockedLower.length > 0) {
        validatedTasks = validatedTasks.filter(task => {
         const taskText = normalizeTopic(
  `${task.title} ${task.description}`
);

const isBlocked = blockedLower.some(blocked =>
  taskText.includes(normalizeTopic(blocked))
);
          if (isBlocked) {
            logger.warn(`[DailyTaskGenerator] Filtered out task "${task.title}" — contains blocked topic`);
          }
          return !isBlocked;
        });
      }

      const difficultyOrder = { easy: 0, medium: 1, hard: 2 };
      const capLevel = difficultyOrder[behaviorProfile.difficultyCap] ?? 2;
      validatedTasks = validatedTasks.filter(task => {
        if (validatedTasks.length === 0) {
  logger.warn('[DailyTaskGenerator] All tasks filtered out. Using fallback tasks.');

  validatedTasks = this.getFallbackTasks(user).slice(
    0,
    behaviorProfile.maxTasks
  );
}
        const taskLevel = difficultyOrder[task.difficulty_level] ?? 1;
        if (taskLevel > capLevel) {
          logger.warn(`[DailyTaskGenerator] Filtered out task "${task.title}" — difficulty ${task.difficulty_level} exceeds cap ${behaviorProfile.difficultyCap}`);
          return false;
        }
        return true;
      });

      const tasksWithDate = validatedTasks.map(task => ({
        ...task,
        assigned_date: date,
        due_date: date,
      }));

      logger.info(`Saving ${tasksWithDate.length} tasks for user ${telegramId}`);
      const { inserted, tasks: savedTasks } = await taskQueries.createTasksIfNotExists(user.id, date, tasksWithDate);
if (!inserted) {
  logger.info(`[DailyTaskGenerator] Tasks already existed for ${telegramId} on ${date} — skipped duplicate insert`);
  const existingTasks = await taskQueries.getDailyTasks(user.id, date);
  logger.info(`Generated ${existingTasks.length} tasks for user ${telegramId} on ${date}`);
  return existingTasks;
}

logger.info(`Generated ${savedTasks.length} tasks for user ${telegramId} on ${date}`);
return savedTasks;
    } catch (error) {
      logger.error(`Task generation failed for user ${telegramId} on ${date}:`, error);
      const user = await userQueries.getUserByTelegramId(telegramId);
      return this.getFallbackTasks(user);
    }
  }

  validateAndFormatTasks(tasks) {
    return tasks.map(task => ({
      title: task.title?.substring(0, 500) || 'Complete today\'s learning goal',
      description: task.description?.substring(0, 1000) || 'Focus on your main goal',
      why_it_matters: task.why_it_matters?.substring(0, 500) || 'This moves you closer to your goal',
      estimated_time: task.estimated_time || '30 minutes',
      difficulty_level: (() => {
        const l = (task.difficulty_level || '').toLowerCase();
        if (l.includes('easy') || l.includes('low') || l.includes('beginner')) return 'easy';
        if (l.includes('hard') || l.includes('high') || l.includes('difficult')) return 'hard';
        return 'medium';
      })(),
    }));
  }

  async getFallbackTasks(user) {
    if (!user) {
      logger.error('getFallbackTasks called with no user');
      return [];
    }

    const fallbackTasks = [
      {
        title: `Review and organize your ${user.goal || 'learning'} materials`,
        description: 'Go through your notes and resources. Identify 3 key topics you need to strengthen.',
        why_it_matters: 'Organization is the foundation of effective learning',
        estimated_time: '30 minutes',
        difficulty_level: 'easy',
      },
      {
        title: 'Complete one focused learning session',
        description: 'Set a timer for 25 minutes and work without distractions on your main topic.',
        why_it_matters: 'Consistent small sessions build momentum',
        estimated_time: '25 minutes',
        difficulty_level: 'medium',
      },
      {
        title: 'Plan tomorrow\'s study session',
        description: 'Write down 3 specific things you want to accomplish in your next study session.',
        why_it_matters: 'Planning reduces decision fatigue and increases follow-through',
        estimated_time: '10 minutes',
        difficulty_level: 'easy',
      },
    ];

    try {
      const savedTasks = await taskQueries.createTasks(user.id, fallbackTasks);
      logger.info(`Saved ${savedTasks.length} fallback tasks for user ${user.telegram_id}`);
      return savedTasks;
    } catch (error) {
      logger.error(`Failed to save fallback tasks for user ${user.telegram_id}:`, error.message);
      return fallbackTasks.map((task, index) => ({
        ...task,
        id: `fallback_${Date.now()}_${index}`,
        user_id: user.id,
        assigned_date: new Date().toISOString().split('T')[0],
        due_date: new Date().toISOString().split('T')[0],
        status: 'pending',
        is_daily: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
    }
  }
}

module.exports = new DailyTaskGenerator();