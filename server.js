require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
// v1.x CJS build exports { TelegramBot }; 0.x exported the class directly.
const { TelegramBot } = require('node-telegram-bot-api');

const config = require('./src/config');
const logger = require('./src/utils/logger');
const { setBot: setAlertBot, alertAdmin } = require('./src/utils/adminAlert');

// Boot-time env sanity. Fail loudly NOW rather than half-working in a way
// that only shows up as a security hole or broken logins later.
if (!process.env.NODE_ENV) {
  logger.warn('NODE_ENV is not set — defaulting to development. Set NODE_ENV=production on live servers.');
}
if (!config.dashboard.jwtSecret || config.dashboard.jwtSecret.length < 32) {
  logger.error('FATAL: JWT_SECRET missing or shorter than 32 chars. Dashboard logins cannot work securely.');
  process.exit(1);
}
if (config.server.env === 'production' && process.env.ENABLE_DEV_LOGIN === 'true') {
  logger.error('FATAL: ENABLE_DEV_LOGIN=true with NODE_ENV=production. Refusing to start with dev auth bypass enabled.');
  process.exit(1);
}

const dashboardRoutes = require('./src/dashboard/dashboardRoutes');

const MessageHandler = require('./src/bot/handlers/messageHandler');
const CallbackHandler = require('./src/bot/handlers/callbackHandler');

const { dailyCron } = require('./src/cron/dailyCron');
const { weeklyCron } = require('./src/cron/weeklyCron');
const { checkinCron } = require('./src/cron/checkinCron');

const app = express();

// Dodo Payments webhook needs the RAW body for signature verification, so it
// mounts BEFORE express.json() — the route applies express.raw() itself.
app.use('/webhooks/dodo', require('./src/routes/dodoWebhook'));

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieParser());

// Security headers (dependency-free helmet-lite)
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'DENY'); // no iframing the dashboard
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set(
    'Content-Security-Policy',
    // telegram.org: Login Widget script + oauth frame; fonts for the UI;
    // 'unsafe-inline' needed by the single-file frontend's inline code.
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://telegram.org; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "img-src 'self' data: https://t.me; " +
    "frame-src https://oauth.telegram.org; " +
    "connect-src 'self'"
  );
  next();
});

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
checkinCron.setBot(bot);

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

let pollingRestartInFlight = false;
let conflictStart = null;
let lastConflictAt = null;

bot.on('polling_error', (error) => {
  logger.error('Polling error:', error.message);

  if (error.code === 'EFATAL') {
    // During an outage EFATAL fires on every failed poll cycle — without a
    // guard each one scheduled its own restart, stacking parallel getUpdates
    // loops that then 409-conflicted with each other.
    if (pollingRestartInFlight) return;
    pollingRestartInFlight = true;

    logger.warn('Fatal polling error — restarting in 5s...');
    alertAdmin('polling', `Fatal polling error: ${error.message} — auto-restarting`);
    setTimeout(() => {
      bot.stopPolling()
        .catch((err) => logger.error('stopPolling failed (continuing to restart):', err.message))
        .then(() => bot.startPolling())
        .then(() => logger.info('Polling restarted'))
        .catch((err) => {
          logger.error('startPolling failed — will retry on next EFATAL:', err.message);
          alertAdmin('polling', `Polling restart FAILED: ${err.message}`);
        })
        .finally(() => { pollingRestartInFlight = false; });
    }, 5000);
    return;
  }

  // v1.x of the bot API exposes error.response.status; 0.x used statusCode.
  const status = error.response?.status ?? error.response?.statusCode;
  if (status === 409) {
    logger.error('Conflict: another bot instance already running.');
    // Render deploys overlap old+new instances for ~10-30s, causing transient
    // 409s on every deploy. Only a conflict that PERSISTS (local server left
    // running alongside Render) is worth an admin alert.
    const now = Date.now();
    if (lastConflictAt && now - lastConflictAt > 60000) conflictStart = null; // stale episode, start over
    if (!conflictStart) conflictStart = now;
    lastConflictAt = now;
    if (now - conflictStart > 90000) {
      alertAdmin('conflict', 'Bot conflict (409) persisting over 90s — a second instance is running (local server?). Kill it.');
    }
  }
});

dailyCron.start();
weeklyCron.start();
checkinCron.start();
logger.info('Cron jobs initialized');

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// (Removed the unauthenticated /webhook status endpoint — misleading name,
// leaked internal cron state. /health covers liveness checks.)

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