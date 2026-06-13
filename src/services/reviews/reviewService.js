const reviewQueries = require('../../database/queries/reviewQueries');
const taskQueries = require('../../database/queries/taskQueries');
const dateUtils = require('../../utils/dateUtils');
const logger = require('../../utils/logger');

class ReviewService {
  async getWeeklyStats(userId) {
    try {
      const weekRange = dateUtils.getWeekRange();
      
      const stats = await taskQueries.getCompletionStats(
        userId,
        weekRange.start,
        weekRange.end
      );

      return {
        ...stats,
        weekStart: weekRange.start,
        weekEnd: weekRange.end,
        weekNumber: dateUtils.getWeekNumber(),
      };
    } catch (error) {
      logger.error(`Failed to get weekly stats for user ${userId}:`, error);
      return null;
    }
  }

  async getLatestReview(userId) {
    try {
      const review = await reviewQueries.getLatestReview(userId);
      return review;
    } catch (error) {
      logger.error(`Failed to get latest review for user ${userId}:`, error);
      return null;
    }
  }

  async formatReviewMessage(review) {
    if (!review) return 'No review available yet.';

    return `📊 *Weekly Review*

━━━━━━━━━━━━━━━

📈 *Stats*
• Tasks Assigned: ${review.tasks_assigned}
• Completed: ${review.tasks_completed}
• Skipped: ${review.tasks_skipped}
• Completion Rate: ${review.completion_rate}%

━━━━━━━━━━━━━━━

📝 *Analysis*
${review.review_text}

━━━━━━━━━━━━━━━

💡 *Recommendations*
${review.recommendations}

━━━━━━━━━━━━━━━

Keep pushing forward! Every task completed is progress toward your goal. 🚀`;
  }
}

module.exports = new ReviewService();