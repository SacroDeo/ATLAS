// src/core/context/contextBuilder.js
const userQueries = require('../../database/queries/userQueries');
const taskQueries = require('../../database/queries/taskQueries');
const conversationEngine = require('../../services/ai/conversationEngine');
const memoryService = require('../../services/memory/memoryService');
const logger = require('../../utils/logger');

class ContextBuilder {
  async build(telegramId, messageText = '') {
    try {
      const user = await userQueries.getUserByTelegramId(telegramId);

      if (!user) {
        logger.error(`ContextBuilder: user not found for telegramId ${telegramId}`);
        return null;
      }

      const today = new Date().toISOString().split('T')[0];

      const [tasks, rawHistory, memory] = await Promise.allSettled([
        taskQueries.getDailyTasks(user.id, today),
        conversationEngine.getHistory(user.id),
        memoryService.getMemory
          ? memoryService.getMemory(user.id)
          : Promise.resolve(null)
      ]);

      // Use .value if fulfilled, fallback to safe default if rejected
      const todayTasks = tasks.status === 'fulfilled' ? (tasks.value || []) : [];
      const history = rawHistory.status === 'fulfilled'
        ? (Array.isArray(rawHistory.value) ? rawHistory.value : [])
        : [];
      const memoryData = memory.status === 'fulfilled' ? (memory.value || null) : null;

      // Strict UserContext shape — every field guaranteed
      return {
        telegramId,
        messageText,
        user: {
          id: user.id,
          telegram_id: user.telegram_id,
          first_name: user.first_name || '',
          goal: user.goal || '',
          biggest_struggle: user.biggest_struggle || '',
          available_time: user.available_time || '',
          domain_knowledge: user.domain_knowledge || '',
          personality_type: user.personality_type || 'friendly',
          current_streak: user.current_streak || 0,
          timezone: user.timezone || 'UTC',
          preferred_time: user.preferred_time || '08:00',
        },
        tasks: todayTasks,
        taskCount: todayTasks.length,
        pendingTasks: todayTasks.filter(t => t.status === 'pending'),
        completedTasks: todayTasks.filter(t => t.status === 'completed'),
        history: history.slice(-10), // last 10 messages only
        memory: memoryData,
        metadata: {
          today,
          timezone: user.timezone || 'UTC',
          personality: user.personality_type || 'friendly',
          currentStreak: user.current_streak || 0,
          hasTasks: todayTasks.length > 0,
          pendingCount: todayTasks.filter(t => t.status === 'pending').length,
          completedCount: todayTasks.filter(t => t.status === 'completed').length,
        }
      };
    } catch (error) {
      logger.error(`ContextBuilder.build failed for ${telegramId}:`, error);
      return null;
    }
  }
}

module.exports = new ContextBuilder();