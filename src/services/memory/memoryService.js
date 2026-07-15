const aiOrchestrator = require('../ai/aiOrchestrator');
const memoryQueries = require('../../database/queries/memoryQueries');
const taskQueries = require('../../database/queries/taskQueries');
const logger = require('../../utils/logger');

class MemoryService {
  async getActiveMemory(userId) {
    try {
      const memory = await memoryQueries.getActiveMemory(userId);
      return memory;
    } catch (error) {
      logger.error(`Failed to get active memory for user ${userId}:`, error);
      return null;
    }
  }

  async updateMemory(userId) {
    try {
      // Collect data for memory update
      const lastWeek = new Date();
      lastWeek.setDate(lastWeek.getDate() - 7);
      
      const recentTasks = await taskQueries.getWeeklyTasks(
        userId,
        lastWeek.toISOString().split('T')[0],
        new Date().toISOString().split('T')[0]
      );

      const currentMemory = await this.getActiveMemory(userId);
      
      // Analyze patterns
      const patterns = this.extractPatterns(recentTasks);
      
      // Generate compressed summary using AI
      const summary = await this.generateCompressedSummary(
        patterns,
        currentMemory?.summary
      );

      // Save new memory
      const newMemory = await memoryQueries.createMemory(userId, {
        summary: summary.text,
        strengths: summary.strengths,
        weaknesses: summary.weaknesses,
        patterns: patterns.behavioral.join(', '),
        strategies: summary.strategies,
        excuses: patterns.skipReasons.join(', '),
        token_count: summary.text.length,
        version: (currentMemory?.version || 0) + 1,
      });

      logger.info(`Memory updated for user ${userId}`);
      return newMemory;
    } catch (error) {
      logger.error(`Failed to update memory for user ${userId}:`, error);
      return null;
    }
  }

  extractPatterns(tasks) {
    const patterns = {
      behavioral: [],
      skipReasons: [],
      successPatterns: [],
    };

    // Analyze completion patterns
    const completedOnTime = tasks.filter(t => 
      t.status === 'completed' && new Date(t.completed_at) <= new Date(t.due_date)
    );
    
    if (completedOnTime.length > tasks.length * 0.7) {
      patterns.behavioral.push('Consistent task completer');
    } else if (completedOnTime.length < tasks.length * 0.3) {
      patterns.behavioral.push('Struggles with timely completion');
    }

    // Analyze skip reasons
    tasks.forEach(task => {
      if (task.skip_reason) {
        patterns.skipReasons.push(task.skip_reason);
      }
    });

    // Analyze difficulty patterns
    const hardTasks = tasks.filter(t => t.difficulty_level === 'hard');
    const hardCompleted = hardTasks.filter(t => t.status === 'completed');
    if (hardTasks.length > 0 && hardCompleted.length / hardTasks.length > 0.7) {
      patterns.behavioral.push('Performs well on challenging tasks');
    }

    return patterns;
  }

  async generateCompressedSummary(patterns, existingSummary) {
    try {
      const prompt = [
        {
          role: 'system',
          content: `Compress the following behavioral data into a concise memory summary (max 200 words):

          Patterns: ${JSON.stringify(patterns)}
          Existing Summary: ${existingSummary || 'New user'}
          
          Create a compressed memory that includes:
          1. Key behavioral traits
          2. Recurring patterns
          3. Effective strategies
          4. Areas needing support
          
          Respond with JSON:
          {
            "text": "Compressed summary",
            "strengths": "Key strengths identified",
            "weaknesses": "Areas for improvement",
            "strategies": "What works for this user"
          }`
        }
      ];

      const result = await aiOrchestrator.executeJSON(prompt, { 
        temperature: 0.5, 
        maxTokens: 300 
      });

      return result;
    } catch (error) {
      logger.error('Failed to generate compressed summary:', error);
      return {
        text: existingSummary || 'New user starting their journey',
        strengths: 'Not enough data',
        weaknesses: 'Not enough data',
        strategies: 'Continue monitoring',
      };
    }
  }
}

module.exports = new MemoryService();