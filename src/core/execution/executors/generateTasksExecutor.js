// src/core/execution/executors/generateTasksExecutor.js
// src/core/execution/executors/generateTasksExecutor.js
const conversationEngine = require('../../../services/ai/conversationEngine');
const taskQueries = require('../../../database/queries/taskQueries');
const timezoneUtils = require('../../../utils/timezoneUtils');
const logger = require('../../../utils/logger');

class GenerateTasksExecutor {

  async execute(plan, context) {
    const user = context.user;

    try {
      const stateManager = require('../../state/stateManager');
      const inlineKeyboards = require('../../../bot/keyboards/inlineKeyboards');
      const userNow = timezoneUtils.getCurrentTimeInZone(user.timezone || 'UTC');
      const today = userNow.toISOString().split('T')[0];

      // A plain "generate/regenerate" REPLACES today's list; a topic-specific
      // request ("tasks on X") APPENDS on top. Either way we never touch the
      // user's unfinished tasks without asking first.
      const isTopicSpecific = !!(plan.payload?.focus_area);

      // GATE: if unfinished work exists (today's OR from earlier days) and this
      // isn't an already-confirmed follow-up, stop and ask what to do. The
      // `_skipPendingGate` flag is set once the user answers the keep/skip prompt.
      if (!plan._skipPendingGate) {
        const unfinished = await taskQueries.getActivePendingUpTo(user.id, today);
        if (unfinished.length > 0) {
          const list = unfinished
            .map((t, i) => `${i + 1}. ${t.title}`)
            .join('\n');

          // Remember the exact request so the button press can regenerate the
          // same thing (including the requested topic) once the user decides.
          stateManager.setContext(user.telegram_id, {
            payload: plan.payload,
            isTopicSpecific,
          });

          const header =
            `⏳ You still have ${unfinished.length} unfinished task${unfinished.length !== 1 ? 's' : ''}:\n\n${list}\n\n`;

          if (isTopicSpecific) {
            return {
              success: false,
              message:
                header +
                `I'll add your new tasks. Keep the unfinished ones too, or skip them first?`,
              reply_markup: inlineKeyboards.pendingAppendDecision().reply_markup,
              data: { pendingTasks: unfinished },
            };
          }

          return {
            success: false,
            message: header + `I won't replace them silently. What do you want to do?`,
            reply_markup: inlineKeyboards.pendingDecision().reply_markup,
            data: { pendingTasks: unfinished },
          };
        }
      }

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

      // Reached the replace path only when nothing was pending (the gate above
      // returned otherwise). Clear any stray pending stragglers WITHOUT touching
      // completed tasks, so today's earned progress/streak stays intact.
      if (!isTopicSpecific) {
        await taskQueries.clearPendingForRegeneration(user.id, today);
      }

      // If the daily cron is mid-generation for this user (fresh lock, no
      // tasks yet), back off instead of racing it into duplicate task sets.
      const { supabase } = require('../../../config/supabase');
      const { data: lockRow } = await supabase
        .from('task_generation_locks')
        .select('created_at')
        .eq('user_id', user.id)
        .eq('assigned_date', today)
        .maybeSingle();
      if (lockRow) {
        const lockAgeMs = Date.now() - new Date(lockRow.created_at).getTime();
        const existingToday = await taskQueries.getDailyTasks(user.id, today);
        if (lockAgeMs < 3 * 60 * 1000 && existingToday.length === 0) {
          return {
            success: false,
            message: '⏳ Your daily tasks are being generated right now — they\'ll arrive in a moment!'
          };
        }
      }

      const savedTasks = [];
      const failedTasks = [];
      for (const task of uniqueTasks) {
        try {
          const saved = await taskQueries.createTasks(user.id, [{
            ...task,
            assigned_date: today,
            due_date: today,
            is_daily: true,
            is_active: true
          }]);
          if (saved && saved.length > 0) {
            savedTasks.push(saved[0]);
          }
        } catch (taskError) {
          failedTasks.push(task.title);
          logger.error(`Failed to save task "${task.title}":`, taskError.message);
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

      // Remind the user how to act on these tasks — the text list is a review
      // step; /start turns them into ✅ buttons.
      const atlasCommands = require('../../../utils/atlasCommands');

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
