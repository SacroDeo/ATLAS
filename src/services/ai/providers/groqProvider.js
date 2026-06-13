// src/services/ai/providers/groqProvider.js
const Groq = require('groq-sdk');
const config = require('../../../config');
const logger = require('../../../utils/logger');
const { AppError } = require('../../../utils/errorHandler');

class GroqProvider {
  constructor() {
    if (!config.ai.groq.apiKey) {
      logger.warn('Groq API key not configured');
      this.client = null;
    } else {
      this.client = new Groq({
        apiKey: config.ai.groq.apiKey,
      });
    }
    this.model = config.ai.groq.model;
    this.maxRetries = 3;
    this.retryDelay = 1000;
  }

  async generateCompletion(messages, options = {}) {
    if (!this.client) {
      throw new AppError('Groq provider not configured', 500);
    }

    let lastError;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Groq request timed out after 15s')), 15000)
        );

        const completion = await Promise.race([
          this.client.chat.completions.create({
            model: this.model,
            messages: messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens || 1000,
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
          throw new Error('Empty completion content');
        }

        logger.info(`Groq completion successful. Tokens used: ${completion.usage?.total_tokens || 'unknown'}`);
        return content;

      } catch (error) {
        lastError = error;
        logger.error(`Groq API attempt ${attempt + 1} failed:`, {
          message: error.message,
          status: error.status,
          code: error.code,
        });

        if (error.status === 401 || error.status === 403) {
          throw new AppError('Groq API authentication failed', error.status);
        }

        if (error.status === 429) {
          const retryAfter = parseInt(error.headers?.['retry-after'] || '5');
          logger.warn(`Rate limited. Waiting ${retryAfter} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }

        if (attempt < this.maxRetries - 1) {
          const delay = this.retryDelay * Math.pow(2, attempt);
          logger.info(`Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new AppError(`Groq API failed after ${this.maxRetries} attempts: ${lastError.message}`, 500);
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