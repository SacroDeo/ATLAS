// src/core/execution/actionExecutor.js
const showGoalExecutor = require('./executors/showGoalExecutor');
const deleteTasksExecutor = require('./executors/deleteTasksExecutor');
const generalChatExecutor = require('./executors/generalChatExecutor');
const showTasksExecutor = require('./executors/showTasksExecutor');
const updateTaskExecutor = require('./executors/updateTaskExecutor');
const showProgressExecutor = require('./executors/showProgressExecutor');
const generateTasksExecutor = require('./executors/generateTasksExecutor');
const updateGoalExecutor = require('./executors/updateGoalExecutor');
const addTaskExecutor = require('./executors/addTaskExecutor');
const ACTIONS = require('../actions/actionTypes');
const logger = require('../../utils/logger');

class ActionExecutor {

  async execute(plan, context) {
    try {
      switch (plan.intent) {

        case ACTIONS.GENERATE_TASKS:
          return await generateTasksExecutor.execute(plan, context);
        
       case ACTIONS.SHOW_PROGRESS:
          return await showProgressExecutor.execute(plan, context);

        case ACTIONS.SHOW_TASKS:
          return await showTasksExecutor.execute(plan, context);

        case 'UPDATE_TASK':
          return await updateTaskExecutor.execute(plan, context);
          
        case ACTIONS.SHOW_GOAL:
          return await showGoalExecutor.execute(plan, context);

        case ACTIONS.DELETE_TASK:
          return await deleteTasksExecutor.execute(plan, context);

        case ACTIONS.DELETE_TASKS:
          return await deleteTasksExecutor.execute(plan, context);

        case ACTIONS.ADD_TASK:
          return await addTaskExecutor.execute(plan, context);

        case ACTIONS.UPDATE_GOALS:
          return await updateGoalExecutor.execute(plan, context);

        case ACTIONS.GENERAL_CHAT:
          return await generalChatExecutor.execute(plan, context);

        default:
          return {
            success: false,
            message: 'Unknown action'
          };
      }
    } catch (error) {
      logger.error(`ActionExecutor failed for intent ${plan.intent}:`, {
        error: error.message,
        userId: context?.user?.telegram_id,
        intent: plan.intent,
        payload: plan.payload
      });
      return {
        success: false,
        message: '😅 Something went wrong. Try again!'
      };
    }
  }
}

module.exports = new ActionExecutor();