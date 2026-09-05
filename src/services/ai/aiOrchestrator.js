// src/services/ai/aiOrchestrator.js
const groqProvider = require('./providers/groqProvider');
const geminiProvider = require('./providers/geminiProvider');
const togetherProvider = require('./providers/togetherProvider');
const config = require('../../config');
const logger = require('../../utils/logger');

class AIOrchestrator {
  constructor() {
    this.providers = {
      groq: groqProvider,
      gemini: geminiProvider,
      together: togetherProvider,
    };
    this.providerOrder = ['groq', 'gemini', 'together'];
  }

  _isRateLimitError(error) {
    const msg = (error?.message || '').toLowerCase();
    return error?.status === 429 || error?.statusCode === 429 || msg.includes('rate limit') || msg.includes('429');
  }

  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _getAvailableProviders() {
    return this.providerOrder.filter(name => {
      const provider = this.providers[name];
      if (!provider) return false;
      if (typeof provider.isConfigured === 'function') {
        return provider.isConfigured();
      }
      return true;
    });
  }

  // ─── Escape-sequence normalisation at the AI boundary ─────────────────────

  /**
   * Turn literal backslash-n / backslash-t sequences into real whitespace.
   *
   * Models routinely emit "line one\nline two" as separate backslash and n
   * characters rather than a real newline — a habit picked up from being trained
   * on JSON — and they double-escape it inside JSON strings, so JSON.parse hands
   * back a literal backslash-n too. That needs repairing, but it used to be
   * repaired inside sanitizeTelegramText, i.e. on EVERY outgoing message, which
   * silently rewrote backslash-n in text the USER typed: ask ATLAS about "\n" in
   * Python and the answer came back with a line break instead (BUG-010). Doing it
   * here confines the repair to AI-authored text, which is the only text that
   * ever needed it. Every AI call in src/ funnels through execute/executeJSON,
   * so this is the complete boundary.
   */
  _unescapeWhitespace(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/\\n/g, '\n').replace(/\\t/g, '  ');
  }

  /** _unescapeWhitespace applied to every string inside a parsed JSON value. */
  _unescapeDeep(value) {
    if (typeof value === 'string') return this._unescapeWhitespace(value);
    if (Array.isArray(value)) return value.map(v => this._unescapeDeep(v));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = this._unescapeDeep(v);
      return out;
    }
    return value;
  }

  // ─── Centralized JSON reliability pipeline ─────────────────────────────────

  /**
   * Centralized JSON extraction and repair.
   * All JSON-parsing from AI responses MUST go through this.
   */
  cleanAIResponse(raw) {
    if (!raw || typeof raw !== 'string') return raw;

    let cleaned = raw;

    // 1. Remove markdown code fences
    cleaned = cleaned.replace(/```json\s*/gi, '');
    cleaned = cleaned.replace(/```\s*/g, '');

    // 2. Remove invisible/control characters EXCEPT newlines and tabs
    cleaned = cleaned.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');

    // 3. Collapse multiple blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // 4. Trim whitespace
    cleaned = cleaned.trim();

    return cleaned;
  }

  /**
   * Attempts to repair common JSON malformations from AI providers.
   */
  repairJSON(jsonString) {
    if (!jsonString || typeof jsonString !== 'string') return jsonString;

    let repaired = jsonString;

    // 1. Extract the first JSON object or array
    const firstBrace = repaired.indexOf('{');
    const firstBracket = repaired.indexOf('[');
    let start = -1;
    let end = -1;

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      start = firstBrace;
      end = repaired.lastIndexOf('}');
    } else if (firstBracket !== -1) {
      start = firstBracket;
      end = repaired.lastIndexOf(']');
    }

    if (start !== -1 && end !== -1 && end > start) {
      repaired = repaired.slice(start, end + 1);
    }

    // 2. Remove trailing commas before } or ]
    repaired = repaired.replace(/,\s*}/g, '}');
    repaired = repaired.replace(/,\s*]/g, ']');


    return repaired;
  }


  /**
   * Executes a prompt and returns parsed JSON with automatic repair and retry.
   *
   * @param {Array} messages - Chat messages array
   * @param {Object} options - { temperature, maxTokens, preferredProvider }
   * @param {Function} schemaValidator - Optional validator function
   * @returns {Object} - Parsed JSON
   */
  async executeJSON(messages, options = {}, schemaValidator = null) {
    if (schemaValidator !== null && typeof schemaValidator !== 'function') {
      logger.warn('[executeJSON] schemaValidator is not a function — ignoring');
      schemaValidator = null;
    }
    let providersToTry = this._getAvailableProviders();

    if (options.preferredProvider && providersToTry.includes(options.preferredProvider)) {
      providersToTry = [options.preferredProvider, ...providersToTry.filter(p => p !== options.preferredProvider)];
    }

    if (providersToTry.length === 0) {
      throw new Error('No AI providers configured.');
    }

    const errors = [];
    const maxAttempts = 2; // First attempt + one retry

    for (const providerName of providersToTry) {
      // Build messages ONCE per provider — add retry context on subsequent attempts
      let attemptMessages = [...messages];

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          logger.info(`[executeJSON] Provider: ${providerName}, Attempt: ${attempt + 1}`);

          const provider = this.providers[providerName];

          // Add retry context on second attempt
          if (attempt > 0) {
            attemptMessages.push({
              role: 'user',
              content: 'Your previous response was malformed or invalid JSON. Return ONLY valid JSON this time. No markdown, no commentary, no code blocks. Just the JSON object.',
            });
          }

          // Use provider's JSON completion if available, otherwise fall back to regular completion + parsing
          let raw;
          if (typeof provider.generateJsonCompletion === 'function') {
            try {
              const parsed = await provider.generateJsonCompletion(attemptMessages, {
                ...options,
                temperature: Math.min(options.temperature || 0.3, 0.3), // Force low temp for JSON
              });
              // If it returned parsed JSON directly, validate and return
              if (parsed && typeof parsed === 'object') {
                if (schemaValidator) {
                  const validation = schemaValidator(parsed);
                  if (validation.valid) return this._unescapeDeep(parsed);
                  logger.warn(`[executeJSON] Schema validation failed: ${validation.error}`);
                } else {
                  return this._unescapeDeep(parsed);
                }
              }
            } catch (providerError) {
              logger.warn(`[executeJSON] Provider JSON completion failed: ${providerError.message}`);
            }
          }

          // Fall back to regular completion + manual parsing
// Fall back to regular completion + manual parsing
          try {
            raw = await provider.generateCompletion(attemptMessages, options);
          } catch (completionError) {
            if (this._isRateLimitError(completionError) && attempt < maxAttempts - 1) {
              await this._sleep(500 * Math.pow(2, attempt));
              continue;
            }
            throw completionError;
          }          logger.info(`[executeJSON] Raw response length: ${raw?.length || 0}`);

          // Clean the response
          let cleaned = this.cleanAIResponse(raw);
          logger.info(`[executeJSON] Cleaned length: ${cleaned?.length || 0}`);

          // Repair and parse
          let repaired = this.repairJSON(cleaned);
          let parsed;

          try {
            parsed = JSON.parse(repaired);
            logger.info(`[executeJSON] JSON parsed successfully on attempt ${attempt + 1}`);
          } catch (parseError) {
            logger.warn(`[executeJSON] JSON parse failed on attempt ${attempt + 1}: ${parseError.message}`);

            // On first failure, retry with the same provider
            if (attempt === 0) {
              logger.info(`[executeJSON] Will retry with repair feedback`);
              continue;
            }

            // On second failure, try next provider
            errors.push({ provider: providerName, error: `Parse error: ${parseError.message}` });
            break;
          }

          // Validate schema if validator provided
          if (schemaValidator) {
            const validation = schemaValidator(parsed);
            if (!validation.valid) {
              logger.warn(`[executeJSON] Schema validation failed: ${validation.error}`);
              if (attempt === 0) {
                attemptMessages.push({
                  role: 'assistant',
                  content: JSON.stringify(parsed),
                });
                attemptMessages.push({
                  role: 'user',
                  content: `The response was valid JSON but failed schema validation: ${validation.error}. Please fix and return ONLY valid JSON.`,
                });
                continue;
              }
              errors.push({ provider: providerName, error: `Schema error: ${validation.error}` });
              break;
            }
          }

          logger.info(`[executeJSON] Success with ${providerName}`);
          return this._unescapeDeep(parsed);

        } catch (error) {
          logger.warn(`[executeJSON] Provider ${providerName} attempt ${attempt + 1} failed: ${error.message}`);
          if (this._isRateLimitError(error) && attempt < maxAttempts - 1) {
            await this._sleep(500 * Math.pow(2, attempt));
            continue;
          }
          if (attempt === maxAttempts - 1) {
            errors.push({ provider: providerName, error: error.message });
          }
        }
      }
    }

    const errorSummary = errors.map(e => `${e.provider}: ${e.error}`).join(' | ');
    throw new Error(`All providers failed to return valid JSON: ${errorSummary}`);
  }

  // ─── Standard execute (text) ──────────────────────────────────────────────

  async execute(messages, options = {}, preferredProvider = null) {
    let providersToTry = this._getAvailableProviders();

    if (preferredProvider && providersToTry.includes(preferredProvider)) {
      providersToTry = [preferredProvider, ...providersToTry.filter(p => p !== preferredProvider)];
    }

    if (providersToTry.length === 0) {
      throw new Error('No AI providers configured. Please set at least one API key.');
    }

    const errors = [];

    // Cap work per provider: one retry, and ONLY on a rate-limit (with backoff).
    // A non-429 error fails over to the next provider immediately — retrying it
    // in place just burns latency. Worst case is now RETRIES_PER_PROVIDER × the
    // provider count instead of the old 3-attempts-each cascade, and the dead
    // `maxRetries = this._isRateLimitErrorCapable ? 2 : 2` line (both branches 2,
    // the flag undefined, the value never read) is gone (BUG-012). On the free
    // tier a 429 usually means the per-window quota is spent, so a second attempt
    // at the SAME provider rarely clears — failover is cheaper and faster.
    const RETRIES_PER_PROVIDER = 1; // 2 attempts total per provider

    for (const providerName of providersToTry) {
      const provider = this.providers[providerName];

      for (let retry = 0; retry <= RETRIES_PER_PROVIDER; retry++) {
        try {
          logger.info(`Trying AI provider: ${providerName} (attempt ${retry + 1})`);
          const result = await provider.generateCompletion(messages, options);
          logger.info(`AI request succeeded with ${providerName}`);
          return this._unescapeWhitespace(result);
        } catch (error) {
          const isRateLimit = this._isRateLimitError(error);
          logger.warn(`Provider ${providerName} attempt ${retry + 1} failed: ${error.message}`);

          if (isRateLimit && retry < RETRIES_PER_PROVIDER) {
            const backoffMs = 500 * Math.pow(2, retry); // 500ms
            logger.info(`Rate limited on ${providerName}, backing off ${backoffMs}ms`);
            await this._sleep(backoffMs);
            continue;
          }

          errors.push({ provider: providerName, error: error.message });
          break; // move to next provider
        }
      }
    }

    const errorSummary = errors.map(e => `${e.provider}: ${e.error}`).join(' | ');
    throw new Error(`All AI providers failed: ${errorSummary}`);
  }

  // ─── Prompt builders (unchanged) ──────────────────────────────────────────

  async generateDailyTasks(userContext, personality) {
    return this.executeJSON(
      this.buildDailyTaskPrompt(userContext, personality),
      { temperature: 0.8, maxTokens: 2000 }
    );
  }

  async generateWeeklyReview(userData, stats, memory) {
    return this.executeJSON(
      this.buildWeeklyReviewPrompt(userData, stats, memory),
      { temperature: 0.7, maxTokens: 1500 }
    );
  }

  async evaluateUnderstanding(question, userResponse, taskContext) {
    return this.executeJSON(
      this.buildSocraticPrompt(question, userResponse, taskContext),
      { temperature: 0.5, maxTokens: 1000 },
      null
    );
  }

  async analyzeBehavior(memoryData, recentActivity) {
    return this.execute(
      this.buildBehaviorAnalysisPrompt(memoryData, recentActivity),
      { temperature: 0.6, maxTokens: 800 }
    );
  }

  /**
   * Generates a warm, sympathetic re-engagement message for a user who has
   * gone quiet for several days. Personalized to their actual goal — NOT a
   * guilt trip. Returns plain text (the raw message to send). Callers must
   * wrap in try/catch and fall back to a template if this throws.
   *
   * @param {Object} user - Full user row (goal, first_name, motivation, biggest_struggle, current_streak)
   * @param {Object} ctx  - { daysSinceLastCompletion }
   * @returns {Promise<string>} - The message text
   */
  async generateReengagementMessage(user, ctx = {}) {
    const text = await this.execute(
      this.buildReengagementPrompt(user, ctx),
      { temperature: 0.8, maxTokens: 300 }
    );
    const cleaned = (text || '').trim();
    if (!cleaned) throw new Error('Empty re-engagement message from AI');
    return cleaned;
  }

  buildReengagementPrompt(user, ctx = {}) {
    const name = user.first_name || 'there';
    const days = ctx.daysSinceLastCompletion || 'a few';
    return [
      {
        role: 'system',
        content: `You are ATLAS, a warm and caring personal goal assistant. One of your users has gone quiet — they haven't completed a task in about ${days} days. Write them a short, sympathetic message to gently invite them back.

User:
- Name: ${name}
- Their goal: ${user.goal || 'their personal goal'}
- Why it matters to them: ${user.motivation || 'unknown'}
- Their biggest struggle: ${user.biggest_struggle || 'unknown'}
- Current streak: ${user.current_streak || 0} days

Rules for the message:
1. Be genuinely warm and empathetic. This is NOT a guilt trip and NOT a scold. Life gets busy — acknowledge that with kindness.
2. Reference their SPECIFIC goal (quote or paraphrase "${user.goal || 'their goal'}") so it feels personal, as if you remember them.
3. Ask one gentle, inviting question — something like whether they'd like to take one small step back today.
4. Keep it to 2-4 short sentences. Warm, human, encouraging. End on an uplifting note.
5. Address them by name (${name}) if it feels natural.
6. Output ONLY the message text — no quotes around it, no preamble, no labels, no markdown headings. A couple of tasteful emojis are welcome.`
      }
    ];
  }

  buildDailyTaskPrompt(userContext, personality) {
    return [
      {
        role: 'system',
        content: `You are ATLAS, an adaptive personal goal assistant. Generate personalized daily tasks based on the user's context.
        
        User Profile:
        - Goal: ${userContext.goal}
- Available Time: ${userContext.available_time}
⚠️ HARD TIME CONSTRAINT: The user has ONLY ${userContext.available_time} per day.
The TOTAL estimated time of ALL tasks combined MUST NOT exceed ${userContext.available_time}.
If available_time is "2 hours", every task's estimated_time added together must be ≤ 120 minutes.
Generate fewer tasks (2-3) if needed to stay within budget. Never exceed this limit under any circumstance.        - Struggle: ${userContext.biggest_struggle}
        - Personality: ${personality}
        - Memory: ${userContext.memory || 'No prior data'}
        - Recent Performance: ${userContext.recentPerformance || 'Starting fresh'}
        
        Generate 2-4 specific, executable tasks for TODAY that fit within the time budget above. Each task must:
        1. Be crystal clear and actionable
        2. Include exact instructions
        3. State estimated time
        4. Explain WHY it matters for their goal
        5. Be achievable within their available time
        
        Respond with JSON:
        {
          "tasks": [
            {
              "title": "Clear action title",
              "description": "Exact step-by-step instructions",
              "why_it_matters": "Connection to their main goal",
              "estimated_time": "X minutes/hours",
              "difficulty_level": "easy/medium/hard"
            }
          ]
        }`
      }
    ];
  }

  buildWeeklyReviewPrompt(userData, stats, memory) {
    return [
      {
        role: 'system',
        content: `Generate a personalized weekly review for this student.
        
        User: ${userData.goal}
        Week Stats:
        - Tasks Assigned: ${stats.total}
        - Completed: ${stats.completed}
        - Skipped: ${stats.skipped}
        - Completion Rate: ${stats.completion_rate}%
        
        Behavioral Memory:
        ${memory || 'No patterns detected yet'}
        
        Write a concise, ${userData.personality_type}-style review covering:
        1. Overall performance
        2. Best and worst performing days
        3. Behavioral patterns noticed
        4. 2-3 specific, actionable recommendations for next week
        5. Encouragement aligned with their personality
        
        Respond with JSON:
        {
          "review_text": "The full review text",
          "recommendations": ["recommendation 1", "recommendation 2", "recommendation 3"]
        }`
      }
    ];
  }

  buildSocraticPrompt(question, userResponse, taskContext) {
    return [
      {
        role: 'system',
        content: `You are evaluating a student's understanding of a task they just completed.

Task context: "${taskContext}"
Question that was asked to them: "${question}"

Read their response carefully and evaluate it as-is — do not assume knowledge they didn't demonstrate.
Do NOT give a generic evaluation. Your output must be based on the exact words they typed.

Respond ONLY with this JSON:
{
  "understanding_level": "deep|moderate|shallow|none",
  "evaluation": "1-2 sentence assessment of what they actually said",
  "follow_up_required": true or false,
  "follow_up_question": "One short follow-up if needed, else null",
  "concepts_grasped": ["concept from their answer"],
  "concepts_missed": ["concept they didn't mention"],
  "recommendation": "One specific, actionable suggestion"
}`
      },
      {
        role: 'user',
        content: userResponse
      }
    ];
  }

  buildBehaviorAnalysisPrompt(memoryData, recentActivity) {
    return [
      {
        role: 'system',
        content: `Analyze this student's behavioral patterns:
        
        Recent Activity: ${JSON.stringify(recentActivity)}
        Previous Memory: ${memoryData}
        
        Identify:
        1. Consistency patterns
        2. Common excuses
        3. Productivity peaks
        4. Struggle areas
        5. Successful strategies
        
        Provide a concise behavioral summary.`
      }
    ];
  }
}

module.exports = new AIOrchestrator();