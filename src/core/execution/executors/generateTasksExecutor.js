// src/core/execution/executors/generateTasksExecutor.js
const conversationEngine = require('../../../services/ai/conversationEngine');
const taskQueries = require('../../../database/queries/taskQueries');
const logger = require('../../../utils/logger');

class GenerateTasksExecutor {

  async execute(plan, context) {
    const user = context.user;

    try {
      const today = new Date().toISOString().split('T')[0];

      const existingTasks = await taskQueries.getDailyTasks(user.id, today);
      const existingTitles = existingTasks.map(t => t.title.toLowerCase().trim());

      const availableTime = user.available_time || '2 hours';
      const timeConstraint = plan.payload?.time_constraint;
      const effectiveTime = timeConstraint
        ? `${timeConstraint.value} ${timeConstraint.unit}`
        : availableTime;

      const structuredContext = {
        active_goal: plan.payload.goal || user.goal,
        focus_area: plan.payload.focus_area || null,
        requested_domain: plan.payload.goal || null,
        existing_task_titles: existingTitles,
        effective_time: effectiveTime
      };

      const taskResult = await conversationEngine.generateTasksFromContext(
        structuredContext,
        user
      );

      if (!taskResult || !taskResult.tasks || taskResult.tasks.length === 0) {
        return {
          success: false,
          message: '❌ Failed to generate tasks. Try again.'
        };
      }

      const uniqueTasks = taskResult.tasks.filter(t => {
        const normalizedTitle = (t.title || '').toLowerCase().trim();
        return !existingTitles.includes(normalizedTitle);
      });

      if (uniqueTasks.length === 0) {
        return {
          success: false,
          message: '⚠️ All generated tasks already exist for today. Try asking for tasks on a specific topic.'
        };
      }

      // FIX: only wipe existing tasks when it's a plain regenerate
      // topic-specific requests APPEND instead of replace
      const isTopicSpecific = !!(structuredContext.focus_area || plan.payload.focus_area);
      if (!isTopicSpecific) {
        await taskQueries.deactivateActiveTasks(user.id);
      }

      const savedTasks = [];
      for (const task of uniqueTasks) {
        try {
          const saved = await taskQueries.createTasks(user.id, [{
            ...task,
            assigned_date: today,
            due_date: today,
            is_daily: true
          }]);
          if (saved && saved.length > 0) {
            savedTasks.push(saved[0]);
          }
        } catch (taskError) {
          if (!taskError.message?.includes('duplicate key') && taskError.code !== '23505') {
            logger.error(`Failed to save task "${task.title}":`, taskError.message);
          }
        }
      }

      if (savedTasks.length === 0) {
        return {
          success: false,
          message: '❌ Could not save any new tasks. Try again with a different topic.'
        };
      }

      const taskList = savedTasks
        .map((t, i) => `${i + 1}. ${t.title}`)
        .join('\n');

      const label = isTopicSpecific ? 'Added' : 'Generated';

      return {
        success: true,
        message: `✅ ${label} ${savedTasks.length} new tasks:\n\n${taskList}`,
        data: { tasks: savedTasks }
      };

    } catch (error) {
      logger.error('GenerateTasksExecutor error:', error);
      return {
        success: false,
        message: '❌ Task generation failed. Try again.'
      };
    }
  }
}

module.exports = new GenerateTasksExecutor();