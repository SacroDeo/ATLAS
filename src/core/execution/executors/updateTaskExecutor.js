const taskQueries = require('../../../database/queries/taskQueries');
const timezoneUtils = require('../../../utils/timezoneUtils');
const logger = require('../../../utils/logger');

async function execute(plan, context) {
  try {
    const { user } = context;
    const { task_number, new_title } = plan.payload;

    if (!task_number || !new_title) {
      return { success: false, message: '❌ Please specify which task number and the new title.' };
    }

    const userNow = timezoneUtils.getCurrentTimeInZone(user.timezone || 'UTC');
const today = userNow.toISOString().split('T')[0];    const tasks = await taskQueries.getDailyTasks(user.id, today);
    // ...rest unchanged

    if (!tasks || tasks.length === 0) {
      return { success: false, message: '📋 No tasks found for today.' };
    }

    const index = task_number - 1;
    if (index < 0 || index >= tasks.length) {
      return {
        success: false,
        message: `❌ Task ${task_number} doesn't exist. You have ${tasks.length} task${tasks.length !== 1 ? 's' : ''} today.`
      };
    }

    const target = tasks[index];
    await taskQueries.updateTask(target.id, {
      title: new_title.slice(0, 120),
      // Full text goes in the description; title gets the truncated form.
      description: new_title,
      updated_at: new Date().toISOString(),
    });

    return {
      success: true,
      message: `✅ Task ${task_number} updated to: *${new_title}*`,
    };

  } catch (error) {
    logger.error('updateTaskExecutor failed:', error);
    return { success: false, message: '😅 Failed to update task. Try again.' };
  }
}

module.exports = { execute };