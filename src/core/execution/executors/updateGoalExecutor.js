// src/core/execution/executors/updateGoalExecutor.js

const userQueries = require('../../../database/queries/userQueries');

class UpdateGoalExecutor {

  async execute(plan, context) {

    try {
      const user = context.user;

      const goalInput = plan.payload?.goal
        || plan.payload?.goals?.[0]
        || null;

      if (!goalInput) {
        return {
          success: false,
          message: '❌ No goal provided. Say: "change my goal to X"'
        };
      }

      const newGoal = goalInput.trim();

      const messageText = context.messageText?.toLowerCase() || '';
      const isAdding = /add|another|also|plus|second|and also/i.test(messageText);

      let finalGoal;
      if (isAdding && user.goal) {
        finalGoal = `${user.goal}, ${newGoal}`;
      } else {
        finalGoal = newGoal;
      }

      await userQueries.updateUserGoals(user.telegram_id, [finalGoal]);

      return {
        success: true,
        message: isAdding
          ? `✅ Added "${newGoal}" to your goals.\n\n🎯 Goals: ${finalGoal}`
          : `✅ Goal updated to: "${finalGoal}"`
      };

    } catch (error) {
      return {
        success: false,
        message: '❌ Failed to update goal. Try again.',
        error
      };
    }
  }
}

module.exports = new UpdateGoalExecutor();