// src/services/ai/providers/geminiProvider.js
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../../../config');
const logger = require('../../../utils/logger');
const { AppError } = require('../../../utils/errorHandler');

class GeminiProvider {
  constructor() {
    this.apiKey = config.ai.gemini.apiKey;
    this.modelName = config.ai.gemini.model;
    this.maxRetries = 3;
    this.retryDelay = 1000;

    if (!this.apiKey) {
      logger.warn('Gemini API key not configured - provider will throw errors if used');
    }
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async generateCompletion(messages, options = {}) {
    if (!this.isConfigured()) {
      throw new AppError('Gemini API key not configured', 500);
    }

    let lastError;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const genAI = new GoogleGenerativeAI(this.apiKey);
        
        const systemMessages = messages.filter(m => m.role === 'system');
        const nonSystemMessages = messages.filter(m => m.role !== 'system');
        
        const systemText = systemMessages.map(m => m.content).join('\n\n');
        
        const modelConfig = {
          model: this.modelName,
        };
        
        if (systemText) {
          modelConfig.systemInstruction = {
            parts: [{ text: systemText }],
          };
        }
        
        const model = genAI.getGenerativeModel(modelConfig);

        const contents = nonSystemMessages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

        const generationConfig = {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxTokens || 1000,
          topP: options.topP ?? 1,
        };

        const result = await model.generateContent({
          contents,
          generationConfig,
        });

        const response = await result.response;
        const text = response.text();

        if (!text) {
          throw new Error('Empty response from Gemini');
        }

        logger.info('Gemini completion successful');
        return text;

      } catch (error) {
        lastError = error;
        
        if (error instanceof AppError) {
          throw error;
        }

        if (error.status === 401 || error.status === 403) {
          throw new AppError('Gemini API authentication failed', error.status);
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