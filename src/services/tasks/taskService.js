// src/services/tasks/taskService.js
const taskQueries = require('../../database/queries/taskQueries');
const userQueries = require('../../database/queries/userQueries');
const socraticEvaluator = require('../ai/socraticEvaluator');
const aiOrchestrator = require('../ai/aiOrchestrator');
const logger = require('../../utils/logger');

class TaskService {
  // FIX 9: Idempotent task completion with atomic conditional update
  async handleTaskComplete(userId, taskId) {
    try {
      const { supabase } = require('../../config/supabase');

      const { data: existing } = await supabase
        .from('tasks')
        .select('status')
        .eq('id', taskId)
        .single();

      if (!existing) {
        throw new Error(`Task ${taskId} not found`);
      }

      if (existing.status === 'completed') {
        return {
          alreadyCompleted: true,
          shouldAskSocratic: false,
        };
      }

      const { data, error } = await supabase
        .from('tasks')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
        })
        .eq('id', taskId)
        .neq('status', 'completed')
        .select('id')
        .single();

      if (error || !data) {
        return {
          alreadyCompleted: true,
          shouldAskSocratic: false,
        };
      }

      // NOTE: streaks are NOT updated here. The morning cron (dailyCron.processUser)
      // is the single streak authority — it evaluates yesterday's full outcome
      // exactly once per user per day. Incrementing at completion time as well
      // double-counted streaks (+2/day for fully-completing users).

      const shouldAsk = await socraticEvaluator.shouldAskSocratic(userId);

      return {
        task: data,
        shouldAskSocratic: shouldAsk,
        alreadyCompleted: false,
      };
    } catch (error) {
      logger.error(`Failed to complete task ${taskId}:`, error);
      throw error;
    }
  }

 async handleTaskSkip(userId, taskId, reason) {
  try {
    const { supabase } = require('../../config/supabase');

    const { error } = await supabase
  .from('tasks')
  .update({
    status: 'skipped',
    skip_reason: reason,
    updated_at: new Date().toISOString(),
  })
  .eq('id', taskId);


    if (error) throw error;

    logger.info(`Task ${taskId} skipped by user ${userId}: ${reason}`);
    return { skipped: true };
  } catch (error) {
    logger.error(`Failed to skip task ${taskId}:`, error);
    throw error;
  }
}

  async handleTaskTooHard(userId, taskId) {
    try {
      const originalTask = await taskQueries.getTaskById(taskId);

      if (originalTask.status === 'too_hard') {
        const today = new Date().toISOString().split('T')[0];
const todayTasks = await taskQueries.getDailyTasks(userId, today);
        const simplifiedTitle = `${originalTask.title} (Simplified)`;
        const existingSimplified = todayTasks.find(t => t.title === simplifiedTitle);
        
        if (existingSimplified) {
          return {
            original: originalTask,
            simplified: existingSimplified,
          };
        }
      }

      await taskQueries.updateTaskStatus(taskId, 'too_hard');
      
      const simplifiedTask = await this.createSimplifiedTask(userId, originalTask);
      
      return {
        original: originalTask,
        simplified: simplifiedTask,
      };
    } catch (error) {
      logger.error(`Failed to handle too hard task ${taskId}:`, error);
      throw error;
    }
  }

  async createSimplifiedTask(userId, originalTask) {
    try {
      const messages = [
        {
          role: 'system',
          content: `You are helping simplify a learning task that was too difficult.
          
          Original task:
          Title: ${originalTask.title}
          Description: ${originalTask.description}
          Estimated time: ${originalTask.estimated_time}
          
          Create a genuinely easier version of this task. Make it:
          1. Shorter and more focused (break it down to just the first step or core concept)
          2. Less intimidating — use simpler language
          3. Achievable in 15-20 minutes
          4. Still meaningful and connected to the learning goal
          
          Respond with JSON:
          {
            "title": "Simplified task title",
            "description": "Clear, simple step-by-step instructions for the easier version"
          }`
        }
      ];

      const result = await aiOrchestrator.executeJSON(messages, { temperature: 0.7, maxTokens: 300 });

      const tasks = await taskQueries.createTasks(userId, [{
        title: result.title || `${originalTask.title} (Simplified)`,
        description: result.description || `Focus on one small part: ${originalTask.description?.split('.')[0] || 'Start with the basics'}`,
        why_it_matters: originalTask.why_it_matters,
        estimated_time: '15-20 minutes',
        difficulty_level: 'easy',
      }]);

      return tasks[0];
    } catch (error) {
      logger.error(`AI simplification failed, using fallback for task ${originalTask.id}:`, error.message);
      
      const simplifiedDescription = originalTask.description
        ? `Let's start small. Just do this one part: ${originalTask.description.split('.')[0]}. That's it for now.`
        : 'Start with the absolute basics. Spend 15 minutes just getting familiar with the topic.';

      const tasks = await taskQueries.createTasks(userId, [{
        title: `${originalTask.title} (Simplified)`,
        description: simplifiedDescription,
        why_it_matters: originalTask.why_it_matters,
        estimated_time: '15 minutes',
        difficulty_level: 'easy',
      }]);

      return tasks[0];
    }
  }

  async getTodayProgress(userId) {
    try {
      const today = new Date().toISOString().split('T')[0];
const todayTasks = await taskQueries.getDailyTasks(userId, today);
      
      const completed = todayTasks.filter(t => t.status === 'completed').length;
      const total = todayTasks.length;
      
      return {
        tasks: todayTasks,
        completed,
        total,
        percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
        remaining: total - completed,
      };
    } catch (error) {
      logger.error(`Failed to get today's progress for user ${userId}:`, error);
      return { tasks: [], completed: 0, total: 0, percentage: 0, remaining: 0 };
    }
  }

  async getUserById(userId) {
    const { supabase } = require('../../config/supabase');
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();
    
    if (error) throw error;
    return data;
  }
}

module.exports = new TaskService();