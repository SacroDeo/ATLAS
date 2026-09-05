// src/core/validation/actionValidator.js

const ACTIONS = require('../actions/actionTypes');

class ActionValidator {
  validate(plan) {

    if (!plan) {
      return {
        valid: false,
        error: 'No plan provided'
      };
    }

    if (!plan.intent) {
      return {
        valid: false,
        error: 'Missing intent'
      };
    }

    const validActions = Object.values(ACTIONS);

    if (!validActions.includes(plan.intent)) {
      return {
        valid: false,
        error: 'Invalid action type'
      };
    }

    // Validate confidence is present and reasonable
    if (typeof plan.confidence !== 'number' || plan.confidence < 0 || plan.confidence > 1) {
      return {
        valid: false,
        error: 'Invalid confidence value'
      };
    }

    // Validate payload is an object
    if (plan.payload && typeof plan.payload !== 'object') {
      return {
        valid: false,
        error: 'Payload must be an object'
      };
    }

    switch (plan.intent) {

      case ACTIONS.DELETE_TASK:
        if (!plan.payload || plan.payload.task_number == null) {
          return { valid: false, error: 'DELETE_TASK requires task_number in payload' };
        }
        return { valid: true };

      case ACTIONS.DELETE_TASKS:
        return this.validateDeleteTasks(plan);

      case ACTIONS.UPDATE_GOALS:
        return this.validateUpdateGoals(plan);

      case ACTIONS.GENERATE_TASKS:
        return this.validateGenerateTasks(plan);

      case ACTIONS.UPDATE_TASK:
        if (!plan.payload || plan.payload.task_number == null || !plan.payload.new_title) {
          return { valid: false, error: 'UPDATE_TASK requires task_number and new_title in payload' };
        }
        return { valid: true };

      case ACTIONS.ADD_TASK:
        if (!plan.payload || !plan.payload.description) {
          return { valid: false, error: 'ADD_TASK requires a description in payload' };
        }
        return { valid: true };

      // Read-only / no-required-payload intents.
      case ACTIONS.SHOW_TASKS:
      case ACTIONS.SHOW_GOAL:
      case ACTIONS.SHOW_PROGRESS:
      case ACTIONS.DISCUSS_GOAL:
      case ACTIONS.GENERAL_CHAT:
        return { valid: true };

      default:
        // Fail closed: a valid-but-unhandled intent must never reach an executor
        // with an unvalidated payload just because a case is missing here (BUG-015).
        return { valid: false, error: `Unhandled intent: ${plan.intent}` };
    }
  }

  validateDeleteTasks(plan) {

    if (!plan.payload) {
      return {
        valid: false,
        error: 'DELETE_TASKS requires payload'
      };
    }

    // An all-null payload used to pass here and reach the executor as a silent
    // no-op (BUG-015). Require either specific number(s) or a target ("all").
    const { task_number, target } = plan.payload;
    if (task_number == null && !target) {
      return {
        valid: false,
        error: 'DELETE_TASKS requires task_number or target in payload'
      };
    }

    return {
      valid: true
    };
  }

  validateUpdateGoals(plan) {
  if (!plan.payload || (!plan.payload.goal && !plan.payload.goals)) {
    return {
      valid: false,
      error: 'UPDATE_GOALS requires goal in payload'
    };
  }

  return { valid: true };
}

  validateGenerateTasks(plan) {
    if (!plan.payload) {
      return {
        valid: false,
        error: 'GENERATE_TASKS requires payload'
      };
    }

    // focus_area and goal are optional for task generation
    return { valid: true };
  }
}

module.exports = new ActionValidator();