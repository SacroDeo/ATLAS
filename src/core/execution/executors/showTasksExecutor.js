// src/core/execution/executors/showTasksExecutor.js

const taskQueries = require('../../../database/queries/taskQueries');
const timezoneUtils = require('../../../utils/timezoneUtils');

class ShowTasksExecutor {

  async execute(plan, context) {
    const user = context.user;

    try {
      const userNow = timezoneUtils.getCurrentTimeInZone(user.timezone || 'UTC');
const today = userNow.toISOString().split('T')[0];      const tasks = await taskQueries.getDailyTasks(user.id, today);
      // ...rest unchanged

      if (!tasks || tasks.length === 0) {
        return {
          success: true,
          message: `You have no tasks for today yet.\n\nSay "generate tasks" and I'll create a personalized plan for you. 🎯`
        };
      }

      const pending = tasks.filter(t => t.status === 'pending');
      const completed = tasks.filter(t => t.status === 'completed');
      const skipped = tasks.filter(t => t.status === 'skipped');

      let message = '';

      if (pending.length > 0) {
        message += `📋 *Pending (${pending.length})*\n`;
        pending.forEach((task, i) => {
          message += `${i + 1}. ${task.title}\n`;
        });
      }

      if (completed.length > 0) {
        message += `\n✅ *Completed (${completed.length})*\n`;
        completed.forEach((task, i) => {
          message += `${i + 1}. ${task.title}\n`;
        });
      }

      if (skipped.length > 0) {
        message += `\n⏭️ *Skipped (${skipped.length})*\n`;
        skipped.forEach((task, i) => {
          message += `${i + 1}. ${task.title}\n`;
        });
      }

      // motivational footer based on progress
      if (pending.length === 0) {
        message += `\n🔥 All done for today! You're on a ${user.current_streak} day streak. Keep it going tomorrow.`;
      } else if (completed.length > 0) {
        message += `\n💪 ${completed.length} down, ${pending.length} to go. You've got this.`;
      } else {
        message += `\n🚀 ${pending.length} task${pending.length > 1 ? 's' : ''} waiting. Let's get started.`;
      }

      return {
        success: true,
        message
      };

    } catch (error) {
      console.error(error);
      return {
        success: false,
        message: '❌ Had trouble fetching your tasks. Try again.'
      };
    }
  }
}

module.exports = new ShowTasksExecutor();