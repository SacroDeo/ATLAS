// src/core/actions/actionRegistry.js

const ACTIONS = require('./actionTypes');

module.exports = {
  [ACTIONS.GENERATE_TASKS]: {
    requiresValidation: true
  },

  [ACTIONS.SHOW_TASKS]: {
    requiresValidation: false
  },

  [ACTIONS.UPDATE_GOALS]: {
    requiresValidation: true
  },

  [ACTIONS.GENERAL_CHAT]: {
    requiresValidation: false
  }
};