const aiOrchestrator = require('./aiOrchestrator');
const taskQueries = require('../../database/queries/taskQueries');
const reviewQueries = require('../../database/queries/reviewQueries');
const memoryService = require('../memory/memoryService');
const dateUtils = require('../../utils/dateUtils');
const logger = require('../../utils/logger');

class WeeklyReviewGenerator {
  async generateReviewForUser(telegramId, user) {
    try {
      const weekRange = dateUtils.getWeekRange();
      const weekNumber = dateUtils.getWeekNumber();

      // Check if review already exists
      const existingReview = await reviewQueries.getReviewByWeek(user.id, weekNumber);
      if (existingReview) {
        logger.info(`Weekly review already exists for user ${telegramId}, week ${weekNumber}`);
        return existingReview;
      }

      // Get weekly stats
      const stats = await taskQueries.getCompletionStats(
        user.id,
        weekRange.start,
        weekRange.end
      );

      if (stats.total < 5) {
        logger.info(`Not enough data for weekly review for user ${telegramId}`);
        return null;
      }

      // Get memory
      const memory = await memoryService.getActiveMemory(user.id);

      // Get daily breakdown
      const dailyStats = await this.getDailyBreakdown(user.id, weekRange.start, weekRange.end);

      // Generate review — executeJSON returns a parsed object
      // { review_text, recommendations: [...] }, not a string.
      const aiReview = await aiOrchestrator.generateWeeklyReview(
        user,
        stats,
        memory?.summary
      );

      const reviewText = typeof aiReview === 'string'
        ? aiReview
        : (aiReview?.review_text || 'No review generated this week.');

      const recommendations = Array.isArray(aiReview?.recommendations) && aiReview.recommendations.length
        ? aiReview.recommendations.slice(0, 3).join(' | ')
        : this.extractRecommendations(reviewText);

      // Save review
      const reviewData = {
        user_id: user.id,
        week_number: weekNumber,
        week_start: weekRange.start,
        week_end: weekRange.end,
        review_text: reviewText,
        completion_rate: stats.completion_rate,
        tasks_assigned: stats.total,
        tasks_completed: stats.completed,
        tasks_skipped: stats.skipped,
        best_day: dailyStats.bestDay || 'N/A',
        worst_day: dailyStats.worstDay || 'N/A',
        patterns_detected: dailyStats.patterns || 'No clear patterns',
        recommendations,
      };

      const savedReview = await reviewQueries.createWeeklyReview(reviewData);
      logger.info(`Weekly review generated for user ${telegramId}`);

      return savedReview;
    } catch (error) {
      logger.error(`Weekly review generation failed for user ${telegramId}:`, error);
      return null;
    }
  }

  async getDailyBreakdown(userId, weekStart, weekEnd) {
    const tasks = await taskQueries.getWeeklyTasks(userId, weekStart, weekEnd);
    
    const dailyCompletion = {};
    tasks.forEach(task => {
      if (!dailyCompletion[task.assigned_date]) {
        dailyCompletion[task.assigned_date] = { total: 0, completed: 0 };
      }
      dailyCompletion[task.assigned_date].total++;
      if (task.status === 'completed') {
        dailyCompletion[task.assigned_date].completed++;
      }
    });

    let bestDay = null;
    let worstDay = null;
    let bestRate = 0;
    let worstRate = 100;

    Object.entries(dailyCompletion).forEach(([date, stats]) => {
      const rate = (stats.completed / stats.total) * 100;
      if (rate > bestRate) {
        bestRate = rate;
        bestDay = date;
      }
      if (rate < worstRate) {
        worstRate = rate;
        worstDay = date;
      }
    });

    return {
      bestDay: bestDay ? dateUtils.formatDate(bestDay) : null,
      worstDay: worstDay ? dateUtils.formatDate(worstDay) : null,
      patterns: this.detectPatterns(dailyCompletion),
    };
  }

  detectPatterns(dailyCompletion) {
    const patterns = [];
    const days = Object.entries(dailyCompletion);
    
    if (days.length < 3) return 'Insufficient data for pattern detection';

    // Check weekend patterns
    const weekendDays = days.filter(([date]) => dateUtils.isWeekend(date));
    const weekdayDays = days.filter(([date]) => !dateUtils.isWeekend(date));
    
    if (weekendDays.length > 0 && weekdayDays.length > 0) {
      const weekendRate = weekendDays.reduce((acc, [, stats]) => 
        acc + (stats.completed / stats.total), 0) / weekendDays.length;
      const weekdayRate = weekdayDays.reduce((acc, [, stats]) => 
        acc + (stats.completed / stats.total), 0) / weekdayDays.length;
      
      if (weekendRate < weekdayRate * 0.7) {
        patterns.push('Lower completion rate on weekends');
      }
    }

    return patterns.join('. ') || 'No clear patterns detected';
  }

  extractRecommendations(reviewText) {
    // Simple extraction - look for recommendation keywords
    const lines = String(reviewText || '').split('\n');
    const recommendations = lines.filter(line => 
      line.toLowerCase().includes('recommend') || 
      line.toLowerCase().includes('suggest') ||
      line.toLowerCase().includes('try') ||
      line.toLowerCase().includes('focus on')
    );
    
    return recommendations.slice(0, 3).join(' | ') || 'Continue with current approach';
  }
}

module.exports = new WeeklyReviewGenerator();