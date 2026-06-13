// src/core/state/stateManager.js

class StateManager {
  constructor() {
    this.states = new Map();
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
}

module.exports = new StateManager();