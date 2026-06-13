
// src/services/ai/providers/togetherProvider.js
const config = require('../../../config');
const logger = require('../../../utils/logger');
const { AppError } = require('../../../utils/errorHandler');

class TogetherProvider {
  constructor() {
    this.apiKey = config.ai.together.apiKey;
    this.model = config.ai.together.model;
    this.baseUrl = 'https://api.together.xyz/v1/chat/completions';
    this.maxRetries = 3;
    this.retryDelay = 1000;

    if (!this.apiKey) {
      logger.warn('Together AI API key not configured - provider will be skipped');
    }
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async generateCompletion(messages, options = {}) {
    if (!this.isConfigured()) {
      throw new AppError('Together AI API key not configured', 500);
    }

    let lastError;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await fetch(this.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens || 1000,
            top_p: options.topP ?? 1,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          
          if (response.status === 401 || response.status === 403) {
            throw new AppError('Together AI authentication failed', response.status);
          }
          
          if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get('retry-after') || '5');
            logger.warn(`Rate limited by Together AI. Waiting ${retryAfter} seconds...`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            continue;
          }

          throw new Error(`Together AI error ${response.status}: ${errorData.error?.message || 'Unknown error'}`);
        }

        const data = await response.json();
        
        if (!data.choices || data.choices.length === 0) {
          throw new Error('No completion choices returned from Together AI');
        }

        const content = data.choices[0].message?.content;
        if (!content) {
          throw new Error('Empty completion content from Together AI');
        }

        logger.info(`Together AI completion successful. Tokens: ${data.usage?.total_tokens || 'unknown'}`);
        return content;

      } catch (error) {
        lastError = error;
        
        if (error instanceof AppError) {
          throw error;
        }

        logger.error(`Together AI attempt ${attempt + 1} failed:`, error.message);

        if (attempt < this.maxRetries - 1) {
          const delay = this.retryDelay * Math.pow(2, attempt);
          logger.info(`Retrying Together AI request in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new AppError(`Together AI failed after ${this.maxRetries} attempts: ${lastError?.message}`, 500);
  }

  async generateJsonCompletion(messages, options = {}) {
    if (!this.isConfigured()) {
      throw new AppError('Together AI API key not configured', 500);
    }

    const systemMessage = {
      role: 'system',
      content: 'You are a JSON API. You must ALWAYS respond with valid JSON only. No markdown, no code blocks, no explanations. Just pure, parseable JSON object.',
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

          throw new AppError('Failed to parse Together AI response as JSON after all attempts', 500);
        }
      } catch (error) {
        lastError = error;
        
        if (error instanceof AppError) {
          throw error;
        }

        if (attempt === this.maxRetries - 1) {
          throw new AppError(`Together AI JSON completion failed: ${error.message}`, 500);
        }

        logger.warn(`JSON completion attempt ${attempt + 1} failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay * Math.pow(2, attempt)));
      }
    }

    throw new AppError(`Together AI JSON completion failed: ${lastError?.message}`, 500);
  }
}

module.exports = new TogetherProvider();