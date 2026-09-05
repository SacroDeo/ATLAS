// src/services/ai/providers/groqProvider.js
const Groq = require('groq-sdk');
const config = require('../../../config');
const logger = require('../../../utils/logger');
const { AppError } = require('../../../utils/errorHandler');

// A 429 means THIS key's bucket is empty, not that Groq is down. With one key the
// only option was to sleep for retry-after; with a pool we can park the spent key
// and immediately try the next one, so a rate limit costs a key rather than a
// user's turn. Sleeping only happens when every key is cooling down.
//
// Cooldown is driven by the response headers when present, because the two
// buckets recover on wildly different timescales: TPM refills in ~1s, the daily
// request/token bucket in hours. Guessing one number for both either wastes
// capacity or hammers a dead key.
const MIN_COOLDOWN_MS = 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 5000;

/** Groq reports resets as "443ms", "1.5s", "44m38.4s", "2h1m". Returns ms, or null. */
function parseResetHeader(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase().replace(/\s+/g, '');

  // "443ms" and "443s" differ by a factor of 1000 and Groq uses both — the TPM
  // bucket routinely resets in milliseconds. This case must be matched before
  // the h/m/s form, or "443ms" reads as 443 seconds and parks a live key for
  // seven minutes it did not need.
  const asMs = s.match(/^(\d+(?:\.\d+)?)ms$/);
  if (asMs) return parseFloat(asMs[1]);

  // Anchored: a header we do not recognise must return null so the caller falls
  // back to a sane default, rather than half-parsing into a wrong number.
  const m = s.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!m) return null;
  const ms =
    (parseFloat(m[1] || 0) * 3600 + parseFloat(m[2] || 0) * 60 + parseFloat(m[3] || 0)) * 1000;
  return ms > 0 ? ms : null;
}

/** Last 4 characters only — a rate-limit log must never carry a usable key. */
function keyTag(key, index) {
  return `#${index}…${String(key).slice(-4)}`;
}

class GroqProvider {
  constructor() {
    const keys = (config.ai.groq.apiKeys && config.ai.groq.apiKeys.length)
      ? config.ai.groq.apiKeys
      : (config.ai.groq.apiKey ? [config.ai.groq.apiKey] : []);

    // One client per key. The SDK holds the key at construction, so a pool of
    // clients is the only way to switch keys without rebuilding on every call.
    //
    // maxRetries: 0 is essential, not tuning. The SDK's default is 2, and it
    // treats 429 as retryable — so a rate-limited key was retried three times
    // with ~2s of internal sleep BEFORE the error reached this class (measured
    // against a local always-429 server: 3 requests, 2048ms). That defeats the
    // pool twice over: the user waits out a sleep the pool exists to skip, and
    // each attempt spends 3 requests from a 1,000/day bucket instead of 1. Worse,
    // the internal sleep pushed calls past the 15s race below, so genuine 429s
    // surfaced here as "timed out" and no key was ever parked. Rotation IS the
    // retry strategy; the SDK must not have its own.
    this.pool = keys.map((key, i) => ({
      key,
      tag: keyTag(key, i),
      client: new Groq({ apiKey: key, maxRetries: 0 }),
      cooldownUntil: 0,
    }));

    this.cursor = 0;

    if (this.pool.length === 0) {
      logger.warn('Groq API key not configured');
      this.client = null;
    } else {
      // Kept for anything that checks `client` directly; the pool is what the
      // request loop actually uses.
      this.client = this.pool[0].client;
      if (this.pool.length > 1) {
        logger.info(`Groq: ${this.pool.length}-key pool active (round-robin with per-key cooldown)`);
      }
    }

    this.model = config.ai.groq.model;
    this.maxRetries = 3;
    this.retryDelay = 1000;
  }

  // aiOrchestrator skips providers whose isConfigured() is false — without
  // this, an unconfigured Groq stayed in the rotation and threw on every call.
  isConfigured() {
    return this.pool.length > 0;
  }

  /**
   * Next key that is not cooling down, advancing the cursor so load spreads
   * instead of always starting at key 0. Returns null when all keys are parked,
   * along with how long until the earliest one frees up.
   */
  _acquire() {
    const now = Date.now();
    for (let i = 0; i < this.pool.length; i++) {
      const entry = this.pool[(this.cursor + i) % this.pool.length];
      if (entry.cooldownUntil <= now) {
        this.cursor = (this.cursor + i + 1) % this.pool.length;
        return entry;
      }
    }
    return null;
  }

  /** Milliseconds until the first key becomes usable again. */
  _soonestAvailableIn() {
    const now = Date.now();
    const soonest = Math.min(...this.pool.map(e => e.cooldownUntil));
    return Math.max(0, soonest - now);
  }

  _park(entry, ms, reason) {
    const wait = Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, ms));
    entry.cooldownUntil = Date.now() + wait;
    logger.warn(`Groq key ${entry.tag} cooling down ${Math.round(wait / 1000)}s (${reason})`);
  }

  async generateCompletion(messages, options = {}) {
    if (this.pool.length === 0) {
      throw new AppError('Groq provider not configured', 500);
    }

    // gpt-oss-120b is a reasoning model: it spends completion tokens on hidden
    // reasoning BEFORE emitting any content, and Groq counts both against
    // max_tokens. A tight budget therefore returns finish_reason "length" with
    // content: "" — measured at 41 reasoning tokens for an intent classification
    // and 105 for a goal-clarity check. Call sites written for a non-reasoning
    // model pass values as low as 5, which produced nothing at all. Floor the
    // budget so reasoning always has room; call sites that ask for more are
    // untouched, and a floor can only ever add headroom, never truncate.
    const REASONING_FLOOR = 512;
    const requested = options.maxTokens || 1000;
    const maxTokens = Math.max(requested, REASONING_FLOOR);

    let lastError;

    // Give every key a shot before giving up: with a pool, "rate limited" should
    // exhaust the pool, not the retry counter.
    const maxAttempts = Math.max(this.maxRetries, this.pool.length);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let entry = this._acquire();

      // All keys parked. Wait for the earliest one rather than failing the turn —
      // but only for as long as the caller can reasonably tolerate.
      if (!entry) {
        const wait = Math.min(this._soonestAvailableIn() + 100, 15000);
        logger.warn(`Groq: all ${this.pool.length} key(s) cooling down, waiting ${wait}ms`);
        await new Promise(resolve => setTimeout(resolve, wait));
        entry = this._acquire();
        if (!entry) {
          lastError = lastError || new Error('all Groq keys rate limited');
          continue;
        }
      }

      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Groq request timed out after 15s')), 15000)
        );

        const completion = await Promise.race([
          entry.client.chat.completions.create({
            model: this.model,
            messages: messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: maxTokens,
            top_p: options.topP ?? 1,
            stream: false,
            stop: options.stop || null,
          }),
          timeoutPromise
        ]);

        if (!completion.choices || completion.choices.length === 0) {
          throw new Error('No completion choices returned');
        }

        const content = completion.choices[0].message?.content;
        if (!content) {
          // Distinguish the two ways content comes back empty, because they need
          // different fixes: hitting the ceiling means the budget was too small
          // for this model's reasoning, not that the provider is broken.
          const finish = completion.choices[0].finish_reason;
          if (finish === 'length') {
            throw new Error(
              `Empty content: reasoning consumed the entire ${maxTokens}-token budget ` +
              `(finish_reason=length). Raise maxTokens for this call site.`
            );
          }
          throw new Error('Empty completion content');
        }

        logger.info(`Groq completion successful. Tokens used: ${completion.usage?.total_tokens || 'unknown'}`);
        return content;

      } catch (error) {
        lastError = error;
        logger.error(`Groq API attempt ${attempt + 1} failed (key ${entry.tag}):`, {
          message: error.message,
          status: error.status,
          code: error.code,
        });

        // A dead key must not sink the pool: park it for the rest of the process
        // and let the next key serve the request. With a single key there is
        // nothing to fall back to, so the old hard failure still applies.
        if (error.status === 401 || error.status === 403) {
          if (this.pool.length > 1) {
            this._park(entry, MAX_COOLDOWN_MS, 'auth failed — key invalid or revoked');
            continue;
          }
          throw new AppError('Groq API authentication failed', error.status);
        }

        if (error.status === 429) {
          // Prefer the reset headers over retry-after: they distinguish the ~1s
          // TPM bucket from the multi-hour daily bucket, so a key that is merely
          // a second behind is not parked for an hour.
          const h = error.headers || {};
          const resetTokens = parseResetHeader(h['x-ratelimit-reset-tokens']);
          const resetRequests = parseResetHeader(h['x-ratelimit-reset-requests']);
          const remainingRequests = Number(h['x-ratelimit-remaining-requests']);
          // Out of daily requests → the long bucket. Otherwise it is TPM.
          const exhaustedDaily = Number.isFinite(remainingRequests) && remainingRequests <= 0;
          const retryAfterMs = h['retry-after'] ? parseFloat(h['retry-after']) * 1000 : null;
          // The two TPM headers answer different questions and differ by ~2x. Measured
          // on a live 429: reset-tokens said 37.147s — the time until the bucket is
          // FULL — while retry-after said 15s and Groq's own message said "try again in
          // 14.625s", the time until THIS request would fit. Parking for the larger
          // number idles a usable key for ~22s on every rate limit. Take the smaller:
          // if a later, bigger request still does not fit, that 429 costs one request
          // out of 1,000/day and re-parks the key — cheaper than sitting out the
          // difference every time.
          const tpm = [resetTokens, retryAfterMs].filter(n => Number.isFinite(n) && n > 0);
          const cooldown = exhaustedDaily
            ? (resetRequests || MAX_COOLDOWN_MS)
            : (tpm.length ? Math.min(...tpm) : DEFAULT_COOLDOWN_MS);

          this._park(entry, cooldown, exhaustedDaily ? 'daily quota spent' : 'rate limited');
          continue;
        }

        if (attempt < maxAttempts - 1) {
          const delay = this.retryDelay * Math.pow(2, Math.min(attempt, 3));
          logger.info(`Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new AppError(`Groq API failed after ${maxAttempts} attempts: ${lastError?.message}`, 500);
  }

  async generateJsonCompletion(messages, options = {}) {
    const systemMessage = {
      role: 'system',
      content: 'You are a JSON API. You must ALWAYS respond with valid JSON only. No markdown, no code blocks, no explanations. Just pure, parseable JSON.',
    };

    const enhancedMessages = [systemMessage, ...messages];

    let lastError;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.generateCompletion(enhancedMessages, {
          ...options,
          temperature: options.temperature ?? 0.3,
          maxTokens: options.maxTokens || 2000,
        });

        let cleanedResponse = response.trim();

        if (cleanedResponse.startsWith('```json')) {
          cleanedResponse = cleanedResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        } else if (cleanedResponse.startsWith('```')) {
          cleanedResponse = cleanedResponse.replace(/```\n?/g, '').trim();
        }

        try {
          const parsed = JSON.parse(cleanedResponse);
          return parsed;
        } catch (parseError) {
          logger.error(`JSON parse attempt ${attempt + 1} failed:`, {
            error: parseError.message,
            responsePreview: cleanedResponse.substring(0, 200),
          });

          if (attempt < this.maxRetries - 1) {
            enhancedMessages.push({
              role: 'assistant',
              content: cleanedResponse,
            });
            enhancedMessages.push({
              role: 'user',
              content: `That response was not valid JSON. Please respond ONLY with valid JSON. No markdown formatting. The error was: ${parseError.message}`,
            });
            continue;
          }

          throw new AppError('Failed to parse Groq response as JSON after all retries', 500);
        }
      } catch (error) {
        lastError = error;
        
        if (error instanceof AppError && error.statusCode === 500) {
          throw error;
        }

        if (attempt === this.maxRetries - 1) {
          throw new AppError(`Groq JSON completion failed: ${error.message}`, 500);
        }

        logger.warn(`JSON completion attempt ${attempt + 1} failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay * Math.pow(2, attempt)));
      }
    }

    throw new AppError(`Groq JSON completion failed after all attempts: ${lastError?.message}`, 500);
  }

  async analyzeBehavior(memoryData, recentActivity) {
    const messages = [
      {
        role: 'system',
        content: 'You are a behavioral analysis expert. Analyze student learning patterns and provide concise, actionable insights.',
      },
      {
        role: 'user',
        content: `Analyze this student's behavioral patterns:

        Recent Activity: ${JSON.stringify(recentActivity, null, 2)}
        Previous Memory: ${memoryData || 'No prior data available'}

        Provide analysis in JSON format:
        {
          "consistency_patterns": "string describing consistency patterns",
          "productivity_peaks": "when they perform best",
          "common_struggles": "recurring difficulties",
          "successful_strategies": "what works for them",
          "risk_areas": "potential problems",
          "recommendations": ["actionable", "recommendations"]
        }`,
      },
    ];

    return this.generateJsonCompletion(messages, { temperature: 0.5, maxTokens: 1000 });
  }

  async evaluateSocraticUnderstanding(question, userResponse, taskContext) {
    const messages = [
      {
        role: 'system',
        content: 'You are an expert educator evaluating student understanding. Be thorough but fair. Focus on depth of comprehension, not just correctness.',
      },
      {
        role: 'user',
        content: `Evaluate this student's understanding:

        Context: ${taskContext}
        Question: "${question}"
        Student Answer: "${userResponse}"

        Respond with JSON:
        {
          "understanding_level": "deep|moderate|shallow|none",
          "evaluation": "detailed assessment",
          "concepts_grasped": ["concept1", "concept2"],
          "concepts_missed": ["concept3"],
          "follow_up_required": true|false,
          "follow_up_question": "intelligent follow-up question if needed",
          "recommendation": "specific improvement suggestion"
        }`,
      },
    ];

    return this.generateJsonCompletion(messages, { temperature: 0.4, maxTokens: 800 });
  }
}

module.exports = new GroqProvider();

// Exposed for unit tests only — the header formats Groq returns are the tricky
// part of the cooldown logic, and they deserve assertions that don't need keys.
module.exports._parseResetHeader = parseResetHeader;
module.exports._GroqProvider = GroqProvider;