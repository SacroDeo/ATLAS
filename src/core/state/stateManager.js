// src/core/state/stateManager.js

class StateManager {
  constructor() {
    this.states = new Map();
    // Separate namespace for richer, object-shaped context (e.g. a deferred
    // task-generation request awaiting a keep/skip button press). Kept apart
    // from `states` so the string-based routing above is never handed an object.
    this.contexts = new Map();
  }

  set(userId, state) {
    this.states.set(userId, {
      state,
      createdAt: Date.now()
    });
  }

  get(userId) {
    const data = this.states.get(userId);

    if (!data) return null;

    const expired =
      Date.now() - data.createdAt >
      10 * 60 * 1000;

    if (expired) {
      this.states.delete(userId);
      return null;
    }

    return data.state;
  }

  clear(userId) {
    this.states.delete(userId);
  }

  setContext(userId, context) {
    this.contexts.set(userId, {
      context,
      createdAt: Date.now()
    });
  }

  getContext(userId) {
    const data = this.contexts.get(userId);

    if (!data) return null;

    const expired =
      Date.now() - data.createdAt >
      10 * 60 * 1000;

    if (expired) {
      this.contexts.delete(userId);
      return null;
    }

    return data.context;
  }

  clearContext(userId) {
    this.contexts.delete(userId);
  }
}

module.exports = new StateManager();