// src/services/ai/providers/geminiProvider.js
const https = require('https');
const config = require('../../../config');
const logger = require('../../../utils/logger');
const { AppError } = require('../../../utils/errorHandler');

// This provider speaks the Gemini REST API directly — it does NOT use the
// @google/generative-ai SDK. The SDK's 0.3.1 release targets the v1 endpoint,
// but thinkingConfig — the only way to stop a Flash model spending hundreds of
// hidden "thinking" tokens per reply — exists only on v1beta. Measured on an
// identical chat payload: 3.6-flash burns ~380 thinking tokens (640 total, 5.9s)
// while 3.5-flash with thinkingBudget 0 costs 274 total at 1.4s. Since Gemini is
// the FAILOVER path, that expensive default was the worst possible place to sit.
//
// Speaking REST keeps the same public shape (generateCompletion /
// generateJsonCompletion / isConfigured), so aiOrchestrator is unchanged. The
// @google/generative-ai package is no longer imported anywhere in the tree and
// can be dropped from package.json on the next dependency update.
const GEMINI_HOST = 'generativelanguage.googleapis.com';
const REQUEST_TIMEOUT_MS = 20000;

class GeminiProvider {
  constructor() {
    this.apiKey = config.ai.gemini.apiKey;
    this.modelName = config.ai.gemini.model;
    this.thinkingBudget = config.ai.gemini.thinkingBudget;
    this.maxRetries = 3;
    this.retryDelay = 1000;

    if (!this.apiKey) {
      logger.warn('Gemini API key not configured - provider will throw errors if used');
    }
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  /**
   * POST to v1beta generateContent. Rejects with an Error carrying `status` and
   * `headers` so the retry logic below can treat 429 and 401 the way it always
   * has.
   */
  _post(body) {
    const payload = JSON.stringify(body);
    const path = `/v1beta/models/${encodeURIComponent(this.modelName)}:generateContent`;

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          method: 'POST',
          host: GEMINI_HOST,
          path,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-goog-api-key': this.apiKey,
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch {
              const err = new Error(`Gemini returned non-JSON (HTTP ${res.statusCode})`);
              err.status = res.statusCode;
              return reject(err);
            }
            if (parsed.error || res.statusCode >= 400) {
              const err = new Error(parsed.error?.message || `Gemini HTTP ${res.statusCode}`);
              err.status = parsed.error?.code || res.statusCode;
              err.headers = res.headers;
              return reject(err);
            }
            resolve(parsed);
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Gemini request timed out after ${REQUEST_TIMEOUT_MS}ms`));
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  async generateCompletion(messages, options = {}) {
    if (!this.isConfigured()) {
      throw new AppError('Gemini API key not configured', 500);
    }

    const systemText = messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n\n');

    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    // Floor mirrors the Groq provider: a caller asking for very few tokens
    // (e.g. maxTokens: 5 for a true/false check) otherwise gets MAX_TOKENS with
    // empty content, and the boolean silently reads false. A floor only adds
    // headroom, never truncates.
    const REASONING_FLOOR = 512;
    const generationConfig = {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: Math.max(options.maxTokens || 1000, REASONING_FLOOR),
      topP: options.topP ?? 1,
    };

    // Budget 0 disables thinking entirely. Some models reject thinkingConfig
    // outright, so a rejection here retries once without it rather than failing
    // the turn — a costlier reply beats no reply.
    let sendThinkingConfig = Number.isFinite(this.thinkingBudget);

    let lastError;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const body = { contents, generationConfig: { ...generationConfig } };
        if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
        if (sendThinkingConfig) {
          body.generationConfig.thinkingConfig = { thinkingBudget: this.thinkingBudget };
        }

        const json = await this._post(body);

        const candidate = json.candidates?.[0];
        const text = (candidate?.content?.parts || [])
          .map(p => p.text || '')
          .join('')
          .trim();

        if (!text) {
          // MAX_TOKENS with no text means the budget went entirely to thinking —
          // the same failure mode the Groq reasoning floor exists to prevent.
          const reason = candidate?.finishReason;
          if (reason === 'MAX_TOKENS') {
            throw new Error(
              `Empty content: thinking consumed the entire ${generationConfig.maxOutputTokens}-token ` +
              `budget (finishReason=MAX_TOKENS)`
            );
          }
          throw new Error(`Empty response from Gemini${reason ? ` (finishReason=${reason})` : ''}`);
        }

        const used = json.usageMetadata || {};
        logger.info(
          `Gemini completion successful. Tokens: ${used.totalTokenCount ?? 'unknown'}` +
          (used.thoughtsTokenCount ? ` (thinking: ${used.thoughtsTokenCount})` : '')
        );
        return text;

      } catch (error) {
        lastError = error;

        if (error instanceof AppError) {
          throw error;
        }

        if (error.status === 401 || error.status === 403) {
          throw new AppError('Gemini API authentication failed', error.status);
        }

        // Model does not support thinkingConfig — drop it and retry immediately
        // rather than burning an attempt on a sleep.
        if (sendThinkingConfig && error.status === 400 && /thinking/i.test(error.message)) {
          logger.warn(`Gemini model ${this.modelName} rejected thinkingConfig — retrying without it`);
          sendThinkingConfig = false;
          continue;
        }

        if (error.status === 429) {
          const retryAfter = parseInt(error.headers?.['retry-after'] || '5');
          logger.warn(`Rate limited by Gemini. Waiting ${retryAfter} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }

        logger.error(`Gemini API attempt ${attempt + 1} failed:`, error.message);

        if (attempt < this.maxRetries - 1) {
          const delay = this.retryDelay * Math.pow(2, attempt);
          logger.info(`Retrying Gemini request in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new AppError(`Gemini API failed after ${this.maxRetries} attempts: ${lastError?.message}`, 500);
  }

  async generateJsonCompletion(messages, options = {}) {
    if (!this.isConfigured()) {
      throw new AppError('Gemini API key not configured', 500);
    }

    const jsonSystemMessage = {
      role: 'system',
      content: 'You are a JSON API. You must ALWAYS respond with valid JSON only. No markdown, no code blocks, no explanations. Just pure, parseable JSON object.',
    };

    const existingSystemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    
    const enhancedMessages = [
      jsonSystemMessage,
      ...existingSystemMessages,
      ...nonSystemMessages,
    ];

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
          cleanedResponse = cleanedResponse.replace(/^```json\s*/g, '').replace(/\s*```$/g, '').trim();
        } else if (cleanedResponse.startsWith('```')) {
          cleanedResponse = cleanedResponse.replace(/^```\s*/g, '').replace(/\s*```$/g, '').trim();
        }

        const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          cleanedResponse = jsonMatch[0];
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
              content: `That response was not valid JSON. Parse error: ${parseError.message}. Please respond ONLY with a valid JSON object. Start your response with { and end with }.`,
            });
            continue;
          }

          throw new AppError('Failed to parse Gemini response as JSON after all attempts', 500);
        }
      } catch (error) {
        lastError = error;
        
        if (error instanceof AppError) {
          throw error;
        }

        if (attempt === this.maxRetries - 1) {
          throw new AppError(`Gemini JSON completion failed: ${error.message}`, 500);
        }

        logger.warn(`JSON completion attempt ${attempt + 1} failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay * Math.pow(2, attempt)));
      }
    }

    throw new AppError(`Gemini JSON completion failed: ${lastError?.message}`, 500);
  }
}

module.exports = new GeminiProvider();