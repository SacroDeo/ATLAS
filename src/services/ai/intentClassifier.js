// src/services/ai/intentClassifier.js
const aiOrchestrator = require('./aiOrchestrator');
const logger = require('../../utils/logger');

const VALID_INTENTS = [
  'ADD_TASK',
  'DELETE_TASK',
  'MODIFY_TASK',
  'VIEW_TASKS',
  'SEEK_ADVICE',
  'DISCUSSION',
  'PROGRESS_CHECK',
  'CHANGE_TIME',
  'CHANGE_TIMEZONE',
  'START_NOW',
  'GENERAL_CHAT',
];

const DEFAULT_RESULT = {
  intent: 'GENERAL_CHAT',
  confidence: 0,
  extracted: {},
};

class IntentClassifier {
  constructor() {
    this.cache = new Map();
    this.cacheMaxSize = 1000;
  }

  async classify(text, userContext) {
    if (!text || text.trim().length === 0) {
      return { ...DEFAULT_RESULT };
    }

    const cacheKey = `${text.substring(0, 50)}_${userContext?.telegram_id || 'anon'}`;
    if (this.cache.has(cacheKey)) {
      return { ...this.cache.get(cacheKey) };
    }

    try {
      const messages = this._buildPrompt(text, userContext);
      const result = await aiOrchestrator.executeJson(messages, {
        temperature: 0.1,
        maxTokens: 150,
      });

      const validated = this._validateResult(result);

      if (this.cache.size >= this.cacheMaxSize) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(cacheKey, { ...validated });

      return validated;
    } catch (error) {
      logger.error('Intent classification failed:', error);
      return this._fallbackClassify(text);
    }
  }

  _buildPrompt(text, userContext) {
    const contextInfo = userContext
      ? `User goal: ${userContext.goal || 'unknown'}. Streak: ${userContext.current_streak || 0} days.`
      : '';

    return [
      {
        role: 'system',
        content: `Classify the user's message into exactly one intent. ${contextInfo}

Available intents:
ADD_TASK - User wants to add/create a new task
DELETE_TASK - User wants to delete/remove a task
MODIFY_TASK - User wants to change/modify/update an existing task
VIEW_TASKS - User wants to see/view/check their tasks
SEEK_ADVICE - User is asking for advice/guidance/recommendations
DISCUSSION - User wants to discuss/explore a topic or idea
PROGRESS_CHECK - User asks about their progress/stats/streak
CHANGE_TIME - User wants to change their preferred task delivery time
CHANGE_TIMEZONE - User wants to change their timezone
START_NOW - User wants to receive tasks immediately right now
GENERAL_CHAT - Casual conversation, greetings, or anything else

Return ONLY valid JSON: {"intent": "INTENT_NAME", "confidence": 0.0-1.0, "extracted": {}}`
      },
      {
        role: 'user',
        content: text,
      },
    ];
  }

  _validateResult(result) {
    if (!result || typeof result !== 'object') {
      return { ...DEFAULT_RESULT };
    }

    const intent = result.intent && VALID_INTENTS.includes(result.intent)
      ? result.intent
      : 'GENERAL_CHAT';

    const confidence = typeof result.confidence === 'number'
      ? Math.max(0, Math.min(1, result.confidence))
      : 0;

    const extracted = result.extracted && typeof result.extracted === 'object'
      ? result.extracted
      : {};

    if (confidence < 0.4) {
      return { intent: 'GENERAL_CHAT', confidence, extracted };
    }

    return { intent, confidence, extracted };
  }

  _fallbackClassify(text) {
    const lower = text.toLowerCase().trim();

    if (/^(hi|hello|hey|yo|sup|good morning|good evening|good night|thanks|thank you|bye|ok|okay|nice|awesome|cool|great|nice|alright)$/i.test(lower)) {
      return { intent: 'GENERAL_CHAT', confidence: 0.5, extracted: {} };
    }

    if (/progress|stats|statistics|how (am i|have i) (doing|performing)|my (performance|streak)/i.test(lower)) {
      return { intent: 'PROGRESS_CHECK', confidence: 0.5, extracted: {} };
    }

    if (/add (a |new )?task|create (a |new )?task/i.test(lower)) {
      return { intent: 'ADD_TASK', confidence: 0.5, extracted: {} };
    }

    if (/delete|remove|cancel/i.test(lower)) {
      return { intent: 'DELETE_TASK', confidence: 0.4, extracted: {} };
    }

    if (/change|modify|update|swap|replace|adjust/i.test(lower)) {
      return { intent: 'MODIFY_TASK', confidence: 0.4, extracted: {} };
    }

    if (/view|show|see|check|what (are|is) my tasks|tomorrow/i.test(lower)) {
      return { intent: 'VIEW_TASKS', confidence: 0.4, extracted: {} };
    }

    if (/start now|send now|give me tasks now|immediately|right now/i.test(lower)) {
      return { intent: 'START_NOW', confidence: 0.5, extracted: {} };
    }

    if (/time|schedule|when|what time/i.test(lower)) {
      return { intent: 'CHANGE_TIME', confidence: 0.3, extracted: {} };
    }

    if (/timezone|time zone/i.test(lower)) {
      return { intent: 'CHANGE_TIMEZONE', confidence: 0.3, extracted: {} };
    }

    if (/advice|help|suggest|recommend|what should|how (do|can|should) i|guide|tip/i.test(lower)) {
      return { intent: 'SEEK_ADVICE', confidence: 0.4, extracted: {} };
    }

    return { ...DEFAULT_RESULT };
  }
}

module.exports = new IntentClassifier();