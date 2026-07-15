// src/core/execution/executors/addTaskExecutor.js
const taskQueries = require('../../../database/queries/taskQueries');
const aiOrchestrator = require('../../../services/ai/aiOrchestrator');
const timezoneUtils = require('../../../utils/timezoneUtils');
const logger = require('../../../utils/logger');

// Detects if input contains a numbered list and splits it into individual items
function extractNumberedList(text) {
  // Strip any leading "add task(s)" prefix line
  const cleaned = text
    .replace(/^add\s+tasks?\s*\n?/im, '')
    .replace(/^add\s+tasks?\s+/i, '')
    .trim();

  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  const numbered = lines.filter(l => /^\d+[\.\)]\s*.+/.test(l));

  if (numbered.length > 1) {
    return numbered.map(l => l.replace(/^\d+[\.\)]\s*/, '').trim());
  }

  // Single item
  if (cleaned.length > 0) return [cleaned];
  return [];
}

async function execute(plan, context) {
  try {
    const { user } = context;
    const userNow = timezoneUtils.getCurrentTimeInZone(user.timezone || 'UTC');
const today = userNow.toISOString().split('T')[0];
    const rawDescription = plan.payload?.description || context.messageText || '';

    if (!rawDescription.trim()) {
      return {
        success: true,
        message: '📝 What task would you like to add? Just describe it.',
        requiresInput: true,
      };
    }

    const taskTitles = extractNumberedList(rawDescription);

    // Build task objects for each title
    const taskObjects = taskTitles.map(title => ({
      title: title.slice(0, 120),
      description: title,
      why_it_matters: `Part of your goal: ${user.goal}`,
      estimated_time: '30 minutes',
      difficulty_level: 'medium',
      assigned_date: today,
      due_date: today,
      is_daily: true,
      is_socratic: false,
      is_socratic: false,
    }));

    const saved = await taskQueries.createTasks(user.id, taskObjects);

    if (!saved || saved.length === 0) {
      return { success: false, message: '😅 Failed to add tasks. Try again.' };
    }

    if (saved.length === 1) {
      return {
        success: true,
        message: `✅ Task added: *${saved[0].title}*`,
      };
    }

    const taskList = saved.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
    return {
      success: true,
      message: `✅ Added ${saved.length} tasks:\n\n${taskList}`,
    };

  } catch (error) {
    logger.error('addTaskExecutor failed:', error);
    if (error.code === '23505') {
      return { success: false, message: '⚠️ One of those tasks already exists for today.' };
    }
    return { success: false, message: '😅 Failed to add task. Try again.' };
  }
}

module.exports = { execute };