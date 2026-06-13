// src/core/validation/taskQualityValidator.js
// Rejects vague or unmeasurable AI-generated tasks.
// Called AFTER AI generates tasks and BEFORE taskQueries.createTasks().
// If a task fails validation, the caller should regenerate or substitute a fallback.

const logger = require('../../utils/logger');

// ─── Vague patterns — tasks matching these are rejected ──────────────────────

const VAGUE_TITLE_PATTERNS = [
  /^practice\s+(coding|programming|development)\.?$/i,
  /^learn\s+\w+\.?$/i,
  /^study\s+\w+\.?$/i,
  /^stay\s+focused\.?$/i,
  /^be\s+productive\.?$/i,
  /^work\s+on\s+(your\s+)?goal\.?$/i,
  /^improve\s+\w+\s+skills?\.?$/i,
  /^do\s+something\s+productive\.?$/i,
  /^focus\s+on\s+learning\.?$/i,
  /^complete\s+today'?s?\s+goal\.?$/i,
  /^make\s+progress\.?$/i,
  /^keep\s+going\.?$/i,
  /^review\s+everything\.?$/i,
  /^read\s+about\s+\w+\.?$/i,
  /^explore\s+\w+\.?$/i,
];

// Titles under this character count are almost certainly vague
const MIN_TITLE_LENGTH = 15;

// Descriptions under this are useless
const MIN_DESCRIPTION_LENGTH = 20;

// ─── Measurability signals — at least one must appear in title or description ─

const MEASURABILITY_SIGNALS = [
  // Quantity
  /\b(\d+)\s+(minutes?|hours?|tasks?|exercises?|problems?|questions?|chapters?|pages?|examples?|commands?|files?|functions?|tests?)\b/i,
  // Completion verbs
  /\b(complete|finish|implement|build|create|write|configure|install|setup|deploy|fix|solve|analyze|review|document|list|identify|compare|test|debug|run|execute)\b/i,
  // Specific references
  /\b(using|with|in|via|on|through)\s+\w+/i,
];

// ─── Validator ────────────────────────────────────────────────────────────────

const taskQualityValidator = {
  /**
   * Validate a single task object.
   *
   * @param {Object} task  - Task with title, description fields
   * @returns {Object}     - { valid: boolean, reason: string | null }
   */
  validateTask(task) {
    const title = (task.title || '').trim();
    const description = (task.description || '').trim();

    // ── Length checks ──
    if (title.length < MIN_TITLE_LENGTH) {
      return {
        valid: false,
        reason: `Title too short (${title.length} chars): "${title}"`,
      };
    }

    if (description.length < MIN_DESCRIPTION_LENGTH) {
      return {
        valid: false,
        reason: `Description too short (${description.length} chars) for task: "${title}"`,
      };
    }

    // ── Vague pattern check on title ──
    for (const pattern of VAGUE_TITLE_PATTERNS) {
      if (pattern.test(title)) {
        return {
          valid: false,
          reason: `Title matches vague pattern "${pattern}": "${title}"`,
        };
      }
    }

    // ── Measurability check — title OR description must contain a signal ──
    const combined = `${title} ${description}`;
    const hasMeasurability = MEASURABILITY_SIGNALS.some(sig => sig.test(combined));

    if (!hasMeasurability) {
      return {
        valid: false,
        reason: `No measurable outcome detected in task: "${title}"`,
      };
    }

    return { valid: true, reason: null };
  },

  /**
   * Validate an array of tasks.
   * Returns { valid[], invalid[] } partitioned arrays, each with validation metadata.
   *
   * @param {Array} tasks
   * @returns {{ validTasks: Array, invalidTasks: Array, allValid: boolean }}
   */
  validateAll(tasks) {
    const validTasks = [];
    const invalidTasks = [];

    for (const task of tasks) {
      const result = this.validateTask(task);
      if (result.valid) {
        validTasks.push(task);
      } else {
        logger.warn(`[TaskQualityValidator] Rejected task — ${result.reason}`);
        invalidTasks.push({ ...task, _rejectionReason: result.reason });
      }
    }

    return {
      validTasks,
      invalidTasks,
      allValid: invalidTasks.length === 0,
    };
  },

  /**
   * Quick check: returns true if at least minValid tasks pass validation.
   * Use this to decide whether to regenerate.
   *
   * @param {Array}  tasks
   * @param {number} minValid  - Minimum acceptable valid tasks (default: 2)
   */
  meetsMinimumQuality(tasks, minValid = 2) {
    const { validTasks } = this.validateAll(tasks);
    return validTasks.length >= minValid;
  },
};

module.exports = taskQualityValidator;