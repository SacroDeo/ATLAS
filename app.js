
require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const config = require('./src/config');
const logger = require('./src/utils/logger');

const MessageHandler = require('./src/bot/handlers/messageHandler');
const CallbackHandler = require('./src/bot/handlers/callbackHandler');

const { dailyCron } = require('./src/cron/dailyCron');
const { weeklyCron } = require('./src/cron/weeklyCron');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const bot = new TelegramBot(config.telegram.token, {
  polling: true,
});

const messageHandler = new MessageHandler(bot);
const callbackHandler = new CallbackHandler(bot);

// Wire up the dependencies so onboarding callbacks work
callbackHandler.setOnboardingFlow(messageHandler.onboardingFlow);
callbackHandler.setMessageHandler(messageHandler);
messageHandler.setCallbackHandler(callbackHandler);
dailyCron.setBot(bot);
weeklyCron.setBot(bot);

bot.on('message', async (msg) => {
  try {
    await messageHandler.handleMessage(msg);
  } catch (error) {
    logger.error('Bot message error:', error);
  }
});

bot.on('callback_query', async (callbackQuery) => {
  try {
    await callbackHandler.handleCallback(callbackQuery);
  } catch (error) {
    logger.error('Bot callback error:', error);
  }
});

bot.on('polling_error', (error) => {
  logger.error('Polling error:', error);
});

dailyCron.start();
weeklyCron.start();

logger.info('Cron jobs initialized');

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.get('/webhook', (req, res) => {
  res.status(200).json({
    bot_active: true,
    cron_jobs: {
      daily: dailyCron.running,
      weekly: weeklyCron.running,
    },
  });
});

app.use((err, req, res, next) => {
  logger.error('Express error:', err);

  res.status(500).json({
    error: 'Internal server error',
    message:
      process.env.NODE_ENV === 'development'
        ? err.message
        : undefined,
  });
});

module.exports = app;
module.exports.bot = bot;
