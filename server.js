require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const TelegramBot = require('node-telegram-bot-api');

const config = require('./src/config');
const logger = require('./src/utils/logger');
const { setBot: setAlertBot, alertAdmin } = require('./src/utils/adminAlert');

const dashboardRoutes = require('./src/dashboard/dashboardRoutes');

const MessageHandler = require('./src/bot/handlers/messageHandler');
const CallbackHandler = require('./src/bot/handlers/callbackHandler');

const { dailyCron } = require('./src/cron/dailyCron');
const { weeklyCron } = require('./src/cron/weeklyCron');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Dashboard: API + static frontend
app.use('/api/dashboard', dashboardRoutes);
app.use(express.static(path.join(__dirname, 'public')));

const bot = new TelegramBot(config.telegram.token, { polling: true });
setAlertBot(bot);

// Last-resort process guards: alert the admin, log, and let the process
// keep running (polling restarts itself; a supervisor restarts hard crashes).
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  alertAdmin('uncaught', `Uncaught exception: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
  alertAdmin('rejection', `Unhandled rejection: ${reason?.stack || reason}`);
});

const messageHandler = new MessageHandler(bot);
const callbackHandler = new CallbackHandler(bot);

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
  logger.error('Polling error:', error.message);

  if (error.code === 'EFATAL') {
    logger.warn('Fatal polling error — restarting in 5s...');
    alertAdmin('polling', `Fatal polling error: ${error.message} — auto-restarting`);
    setTimeout(() => {
      bot.stopPolling().then(() => bot.startPolling());
    }, 5000);
    return;
  }

  if (error.response?.statusCode === 409) {
    logger.error('Conflict: another bot instance already running.');
    alertAdmin('conflict', 'Two bot instances are polling at once (409). Kill one.');
  }
});

dailyCron.start();
weeklyCron.start();
logger.info('Cron jobs initialized');

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

app.get('/webhook', (req, res) => {
  res.status(200).json({ bot_active: true, cron_jobs: { daily: dailyCron.running, weekly: weeklyCron.running } });
});

app.use((err, req, res, next) => {
  logger.error('Express error:', err);
  alertAdmin('express', `Express 500 on ${req.method} ${req.path}: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(config.server.port, () => {
  logger.info(`HTTP server listening on port ${config.server.port}`);
});

module.exports = app;
module.exports.bot = bot;
module.exports.server = server;