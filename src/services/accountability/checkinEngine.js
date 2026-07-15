// src/services/accountability/checkinEngine.js
// Generates intelligent, personal accountability notifications.
// Uses templates + variable injection for 95% of cases.
// Calls AI ONLY for: burnout recovery, dead-user revival, emotionally complex situations.

const aiOrchestrator = require('../ai/aiOrchestrator');
const logger = require('../../utils/logger');

// ─── Template Library ─────────────────────────────────────────────────────────
// Variables: {name} {goal} {streak} {days} {hours} {time}

const TEMPLATES = {
  // ── Momentum reminders (user is on track, gentle nudge) ──
  momentum: [
    "You've completed tasks {streak} days in a row, {name}. Keep that chain unbroken — your future self will thank you.",
    "Streak: {streak} days. You said you wanted to {goal} — today is one more step toward that.",
    "You've been consistent this week, {name}. Don't break the momentum now. Your tasks are waiting.",
    "{streak} days of showing up. That's not luck — that's discipline. One more day.",
  ],

  // ── Recovery reminders (mild slip, 1–2 days missed) ──
  recovery: [
    "Missing one day doesn't erase your progress. You still have {streak} days behind you, {name}.",
    "You're {hours} hours behind on today's tasks. A 20-minute session right now still counts.",
    "Setbacks are part of the process. Your goal of {goal} is still within reach — but only if you start again today.",
    "{name}, you've recovered before. Yesterday doesn't have to define today.",
  ],

  // ── Burnout prevention (high effort lately, risk of stopping) ──
  burnoutPrevention: [
    "{name}, you've been working hard. It's okay to do one lighter task today instead of three.",
    "Burnout kills streaks faster than laziness does. Do the minimum today: one task, 20 minutes.",
    "Your progress toward {goal} doesn't require perfection. Showing up is enough today.",
  ],

  // ── Goal reconnect (user may have forgotten WHY they started) ──
  goalReconnect: [
    "You started this journey because you wanted to {goal}. That reason hasn't changed, {name}.",
    "{name}, remember why you signed up. {goal} is still waiting for you.",
    "The version of you who set the goal of {goal} is counting on today's version to show up.",
  ],

  // ── Inactivity revival (2–3 days inactive, not yet critical) ──
  inactivityRevival: [
    "{name}, you've been away for {days} days. Come back — even 15 minutes today rebuilds the habit.",
    "It's been {days} days, {name}. Your goal of {goal} hasn't moved, but you have. Let's fix that.",
    "Re-entry is the hardest part. One small task today is all it takes to reset the pattern.",
  ],

  // ── Evening reflection (end of day, tasks incomplete) ──
  eveningReflection: [
    "End of day check-in: how many tasks did you complete today, {name}?",
    "Before you sleep — did you make progress on {goal} today? Even 30 minutes counts.",
    "Evening check: your tasks are still open, {name}. There's still time tonight.",
  ],

  // ── Smart timing (user's known productive window) ──
  smartTiming: [
    "{name}, this is your usual productive window. Your tasks are ready when you are.",
    "Your patterns show you work best around this time. Your {goal} tasks are waiting.",
    "Peak time detected, {name}. Open the app and get one task done before the window closes.",
  ],
};

// ─── AI Trigger Thresholds ────────────────────────────────────────────────────

const AI_TRIGGER = {
  INACTIVITY_DAYS_FOR_REVIVAL: 5,   // dead user — needs personal AI message
  BURNOUT_RECOVERY: true,            // always use AI for burnout recovery messages
};

// ─── Engine ───────────────────────────────────────────────────────────────────

const checkinEngine = {
  /**
   * Generate a check-in message for a user based on their engagement snapshot.
   * Returns { text: string, usedAI: boolean, type: string }
   *
   * @param {Object} user       - Full user row
   * @param {Object} snapshot   - From engagementAnalyzer.analyze()
   * @param {string} period     - 'morning' | 'midday' | 'evening' | 'inactivity'
   */
  async generate(user, snapshot, period) {
    try {
      const type = this._selectType(snapshot, period);
      const inactivityDays = Math.floor(snapshot.inactivityHours / 24);

      // ── Use AI for dead user revival ──
      if (
        inactivityDays >= AI_TRIGGER.INACTIVITY_DAYS_FOR_REVIVAL ||
        (type === 'burnoutRecovery' && AI_TRIGGER.BURNOUT_RECOVERY)
      ) {
        const text = await this._generateAIMessage(user, snapshot, type);
        return { text, usedAI: true, type };
      }

      // ── Template path for everything else ──
      const text = this._renderTemplate(type, user, snapshot);
      return { text, usedAI: false, type };

    } catch (error) {
      logger.error(`[CheckinEngine] Failed for user ${user.telegram_id}:`, error);
      // Absolute fallback — never crash the notification flow
      return {
        text: `Hey ${user.first_name || 'there'} — your tasks are waiting. One small step today keeps your streak alive.`,
        usedAI: false,
        type: 'fallback',
      };
    }
  },

  // ─── Type Selector ──────────────────────────────────────────────────────────

  /**
   * Deterministically selects which check-in type to use.
   * Priority order matters.
   */
  _selectType(snapshot, period) {
    const inactivityDays = Math.floor(snapshot.inactivityHours / 24);

    // Inactivity always overrides period
    if (inactivityDays >= 2) return 'inactivityRevival';

    // Burnout takes priority over generic encouragement
    if (snapshot.burnoutRisk === 'high') return 'burnoutPrevention';

    // Period-specific selection
    switch (period) {
      case 'morning':
        if (snapshot.streakRisk === 'high' || snapshot.streakRisk === 'critical') return 'goalReconnect';
        if (snapshot.motivationState === 'declining' || snapshot.motivationState === 'collapsed') return 'recovery';
        return 'momentum';

      case 'midday':
        if (snapshot.completionRate === 0) return 'recovery';
        if (snapshot.motivationState === 'strong') return 'momentum';
        return 'goalReconnect';

      case 'evening':
        return 'eveningReflection';

      case 'smartTiming':
        return 'smartTiming';

      default:
        return 'momentum';
    }
  },

  // ─── Template Renderer ──────────────────────────────────────────────────────

  _renderTemplate(type, user, snapshot) {
    const pool = TEMPLATES[type] || TEMPLATES.momentum;
    // Deterministic selection to avoid repeating the same message.
    // user.id is a UUID string, so hash it instead of using % directly
    // (string % number is NaN, which used to crash this function).
    const idHash = String(user.id || '')
      .split('')
      .reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 0);
    const index = idHash % pool.length;
    const template = pool[index];

    const inactivityDays = Math.floor(snapshot.inactivityHours / 24);
    const productiveHour = this._getProductiveTimeLabel(user);

    return template
      .replace(/{name}/g, user.first_name || 'there')
      .replace(/{goal}/g, this._shortGoal(user.goal))
      .replace(/{streak}/g, String(user.current_streak || 0))
      .replace(/{days}/g, String(inactivityDays))
      .replace(/{hours}/g, String(Math.round(snapshot.inactivityHours)))
      .replace(/{time}/g, productiveHour);
  },

  // ─── AI Message Generator ────────────────────────────────────────────────────
  // Called only for: dead user revival (5+ days), burnout recovery

  async _generateAIMessage(user, snapshot, type) {
    const inactivityDays = Math.floor(snapshot.inactivityHours / 24);

    const systemPrompt = type === 'inactivityRevival'
      ? `You are ATLAS, a supportive personal goal assistant. Write a single short (2-3 sentence) message to re-engage ${user.first_name || 'the user'} who has been inactive for ${inactivityDays} days.

Their goal: ${user.goal}
Their biggest struggle: ${user.biggest_struggle || 'staying consistent'}
Current streak: ${user.current_streak || 0} days

Rules:
- Reference their specific goal, not generic motivation
- Be warm but direct — not preachy
- DO NOT use: "believe in yourself", "you can do it", "stay motivated"
- Max 3 sentences
- No emojis unless 1 max at the start
- Return ONLY the message text, nothing else`

      : `You are ATLAS. Write a 2-sentence burnout recovery message for ${user.first_name || 'the user'}.

Their goal: ${user.goal}
Recent pattern: completed ${Math.round(snapshot.completionRate * 100)}% of tasks, ${Math.round(snapshot.tooHardRate * 100)}% marked as too hard.

Rules:
- Acknowledge the effort, suggest a lighter approach today
- DO NOT be dismissive or overly positive
- Max 2 sentences
- Return ONLY the message text`;

    try {
      const response = await aiOrchestrator.execute(
        [{ role: 'system', content: systemPrompt }],
        { temperature: 0.7, maxTokens: 120 }
      );
      return response.trim();
    } catch (error) {
      logger.error(`[CheckinEngine] AI message generation failed:`, error);
      // Fall back to template
      return this._renderTemplate(type, user, snapshot);
    }
  },

  // ─── Helpers ────────────────────────────────────────────────────────────────

  _shortGoal(goal) {
    if (!goal) return 'your goal';
    // Truncate long goals for readability in messages
    return goal.length > 50 ? goal.substring(0, 47) + '…' : goal;
  },

  _getProductiveTimeLabel(user) {
    // Will be enriched by behavioralTimingSystem when available
    return user.preferred_time || 'your usual time';
  },
};

module.exports = checkinEngine;