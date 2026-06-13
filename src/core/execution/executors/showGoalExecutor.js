// src/core/execution/executors/showGoalExecutor.js

class ShowGoalExecutor {
  async execute(plan, context) {
    const user = context.user;

    if (!user.goal) {
      return {
        success: true,
        message: '🎯 You have no goal set yet. Say "change my goal to X" to set one.'
      };
    }

    return {
      success: true,
      message: `🎯 Your current goal: ${user.goal}`
    };
  }
}

module.exports = new ShowGoalExecutor();