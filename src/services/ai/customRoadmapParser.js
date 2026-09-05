// src/services/ai/customRoadmapParser.js
// Converts a user-pasted roadmap (any format — bullets, numbered weeks,
// paragraphs) into the SAME {roadmap_text, roadmap_json} shape that
// roadmapGenerator produces, so dailyTaskGenerator's phase logic works
// unchanged regardless of who authored the roadmap.

const aiOrchestrator = require('./aiOrchestrator');
const userQueries = require('../../database/queries/userQueries');
const logger = require('../../utils/logger');
const { sanitizeForPrompt } = require('../../utils/promptSanitizer');

const customRoadmapParser = {
  /**
   * Parse and SAVE the user's own roadmap.
   * Returns the cleaned roadmap text on success, null when unparseable.
   */
  async importRoadmap(user, pastedText) {
    const telegramId = user.telegram_id;

    const systemContent = `The user of a goal-assistant bot pasted THEIR OWN roadmap/plan. Convert it into the bot's internal structure. DO NOT invent a different plan — preserve their phases, ordering, topics and wording as faithfully as possible.

USER GOAL: "${sanitizeForPrompt(user.goal || 'not stated', 500)}"

THEIR ROADMAP (verbatim):
"""
${sanitizeForPrompt(pastedText, 4000)}
"""

Rules:
- Keep THEIR structure. If they numbered weeks/months/steps, one phase per week/month/step (cap 12 phases — merge the tail if longer).
- If it's unstructured prose, split it into 2-6 logical sequential phases.
- phase_name: short, taken from their wording where possible.
- difficulty: your best judgement (easy|medium|hard) per phase, easier first.
- allowed_topics: the concrete topics/tools THEY mention in that phase.
- completion_requirements: concrete deliverables from their text (or a sensible one if none).
- roadmap_text: a clean Telegram-markdown rendering of THEIR plan, starting with "🗺️ *Your Roadmap:*" then one "*Phase N: Name* — summary" line per phase.
- If the pasted text is NOT a plan/roadmap at all (random chat, a question, gibberish), return exactly: {"not_a_roadmap": true}

Respond with ONLY JSON:
{
  "roadmap_text": "...",
  "roadmap_json": {
    "phases": [
      { "phase_index": 1, "phase_name": "...", "difficulty": "easy",
        "allowed_topics": ["..."], "blocked_topics": [],
        "completion_requirements": ["..."] }
    ]
  }
}`;

    let result = null;
    try {
      const raw = await aiOrchestrator.execute(
        [{ role: 'system', content: systemContent }],
        { temperature: 0.2, maxTokens: 1800 }
      );
      result = this._parseJson(raw);
    } catch (err) {
      logger.error(`[CustomRoadmap] AI parse failed for ${telegramId}:`, err);
      return null;
    }

    if (!result || result.not_a_roadmap) return null;
    if (
      !result.roadmap_text ||
      !Array.isArray(result.roadmap_json?.phases) ||
      result.roadmap_json.phases.length === 0
    ) {
      return null;
    }

    // Normalize: indices sequential, arrays present — the task generator
    // trusts this shape.
    result.roadmap_json.phases = result.roadmap_json.phases.slice(0, 12).map((p, i) => ({
      phase_index: i + 1,
      phase_name: String(p.phase_name || `Phase ${i + 1}`).slice(0, 120),
      difficulty: ['easy', 'medium', 'hard'].includes(p.difficulty) ? p.difficulty : 'medium',
      allowed_topics: Array.isArray(p.allowed_topics) ? p.allowed_topics.slice(0, 15) : [],
      blocked_topics: [],
      completion_requirements: Array.isArray(p.completion_requirements)
        ? p.completion_requirements.slice(0, 8)
        : [],
    }));
    result.roadmap_json.current_phase_index = 1;
    result.roadmap_json.source = 'user';

    await userQueries.updateOnboardingState(telegramId, 'completed', {
      roadmap: result.roadmap_text.trim(),
    });
    await userQueries.saveRoadmapJson(telegramId, result.roadmap_json);
    logger.info(`[CustomRoadmap] Imported user roadmap for ${telegramId}: ${result.roadmap_json.phases.length} phases`);

    return result.roadmap_text.trim();
  },

  _parseJson(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try { return JSON.parse(raw.trim()); } catch {}
    try {
      const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      const first = cleaned.indexOf('{');
      const last = cleaned.lastIndexOf('}');
      if (first === -1 || last === -1) return null;
      let s = cleaned.slice(first, last + 1)
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']');
      return JSON.parse(s);
    } catch (err) {
      logger.error('[CustomRoadmap] JSON parse failed:', err.message);
      return null;
    }
  },
};

module.exports = customRoadmapParser;
