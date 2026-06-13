// src/services/ai/validators/taskValidator.js

function validate(parsed) {
  if (!parsed) return { valid: false, error: 'Parsed result is null/undefined' };
  const tasks = parsed.tasks || parsed;
  if (!Array.isArray(tasks)) {
    return { valid: false, error: 'tasks is not an array' };
  }
  if (tasks.length === 0) {
    return { valid: false, error: 'tasks array is empty' };
  }
  for (let i = 0; i < tasks.length; i++) {
    if (!tasks[i].title || typeof tasks[i].title !== 'string') {
      return { valid: false, error: `Task ${i} missing or invalid title` };
    }
  }
  return { valid: true, error: null };
}

module.exports = { validate };