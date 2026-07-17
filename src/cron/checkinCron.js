// src/cron/checkinCron.js
// Task-related check-in notifications, driven by the (previously orphaned)
// checkinEngine + engagementAnalyzer pair.
//
// Two timezone-aware touchpoints per user per day, both about their tasks:
//   MIDDAY  (~13:00 local) — nudge ONLY if tasks are still pending; for users
//            inactive 2+ days this becomes the re-engagement message instead.
//   EVENING (~20:00 local) — reflection if tasks remain; a short congrats if
//            everything got done; nothing if no tasks were assigned.
//
// Dedup: one row per (user, date, checkin_type) via the checkins table's
// ignoreDuplicates upsert — same mechanism the morning flow already uses —
// plus an in-memory guard so a DB hiccup can't double-send within a run.

const cron = require('node-cron');
const logger = require('../utils/logger');
const timezoneUtils = require('../utils/timezoneUtils');
const userQueries = require('../database/queries/userQueries');
const taskQueries = require('../database/queries/taskQueries');
const checkinQueries = require('../database/queries/checkinQueries');
const engagementAnalyzer = require('../services/accountability/engagementAnalyzer');
const checkinEngine = require('../services/accountability/checkinEngine');
const telegramClient = require('../utils/telegram/telegramClient');

// Local-time delivery windows. Wide enough that a 5-min tick can't skip one.
const WINDOWS = {
  midday: { startHour: 13, startMin: 0, endHour: 13, endMin: 30 },
  evening: { startHour: 20, startMin: 0, endHour: 20, endMin: 30 },
};

// Inactive users get at most one revival ping every REVIVAL_EVERY_DAYS days,
// and none at all past REVIVAL_GIVE_UP_DAYS — a goal assistant checks in,
// it doesn't spam a dead chat.
const REVIVAL_EVERY_DAYS = 2;
const REVIVAL_GIVE_UP_DAYS = 14;

class CheckinCron {
  constructor() {
    this.bot = null;
    this.job = null;
    this.running = false;
    // 'userId:date:period' sent this process lifetime (backup dedup)
    this.sentGuard = new Set();
  }

  setBot(bot) {
    this.bot = bot;
  }

  start() {
    // Every 5 minutes is plenty for 30-minute windows and keeps DB load low.
    this.job = cron.schedule('*/5 * * * *', async () => {
      await this.tick();
    }, { scheduled: true, timezone: 'UTC' });

    this.running = true;
    logger.info('Check-in cron scheduled - midday & evening task check-ins, per-user timezone');
  }

  stop() {
    if (this.job) this.job.stop();
    this.running = false;
  }

  async tick() {
    try {
      const users = await userQueries.getAllActiveUsers();
      for (const user of users) {
        try {
          const period = this._periodInWindow(user);
          if (!period) continue;
          await this._processUser(user, period);
        } catch (err) {
          logger.error(`[CheckinCron] Failed for user ${user.telegram_id}:`, err);
          if (await userQueries.deactivateIfUnreachable(user.id, err)) {
            logger.info(`[CheckinCron] User ${user.telegram_id} unreachable — marked inactive`);
          }
        }
      }
    } catch (err) {
      logger.error('[CheckinCron] tick failed:', err);
    }
  }

  /** Which window (if any) the user's local clock is inside right now. */
  _periodInWindow(user) {
    const tz = user.timezone || 'UTC';
    const now = timezoneUtils.getCurrentTimeInZone(tz);
    const mins = now.getHours() * 60 + now.getMinutes();

    for (const [period, w] of Object.entries(WINDOWS)) {
      const start = w.startHour * 60 + w.startMin;
      const end = w.endHour * 60 + w.endMin;
      if (mins >= start && mins <= end) return period;
    }
    return null;
  }

  async _processUser(user, period) {
    const tz = user.timezone || 'UTC';
    const userToday = timezoneUtils.getLocalDateString(tz);

    // Backup in-memory dedup (primary dedup is the checkins upsert below).
    const guardKey = `${user.id}:${userToday}:${period}`;
    if (this.sentGuard.has(guardKey)) return;

    const tasks = await taskQueries.getDailyTasks(user.id, userToday);
    const pending = tasks.filter((t) => t.status === 'pending');
    const completed = tasks.filter((t) => t.status === 'completed');

    const snapshot = await engagementAnalyzer.analyze(user);
    const inactivityDays = Math.floor(snapshot.inactivityHours / 24);

    // Long-gone users: revival pings only at midday, only every 2nd day,
    // and we stop trying after two weeks.
    if (inactivityDays >= 2) {
      if (period !== 'midday') return;
      if (inactivityDays > REVIVAL_GIVE_UP_DAYS) return;
      if (inactivityDays % REVIVAL_EVERY_DAYS !== 0) return;
    } else {
      // Active users: only speak when there's something task-related to say.
      if (period === 'midday' && pending.length === 0) return;
      if (period === 'evening' && tasks.length === 0) return;
    }

    // Primary dedup: atomic insert; a second attempt for the same
    // (user, date, type) comes back null and we bail before sending.
    let marker = null;
    let dbDedupAvailable = true;
    try {
      marker = await checkinQueries.createCheckin(user.id, {
        type: `checkin_${period}`,
        date: userToday,
        response: null,
        mood_rating: null,
      });
    } catch (err) {
      // 23514 = the checkins CHECK constraint doesn't allow our types yet
      // (migration 001_checkin_types.sql not applied). Don't let that kill
      // the feature — fall back to in-memory dedup and nag the admin once.
      if (err && err.code === '23514') {
        dbDedupAvailable = false;
        if (!this.constraintWarned) {
          this.constraintWarned = true;
          logger.error('[CheckinCron] checkins CHECK constraint rejects checkin types — run src/database/migrations/001_checkin_types.sql. Falling back to in-memory dedup.');
        }
      } else {
        throw err;
      }
    }
    if (dbDedupAvailable && !marker) return; // already sent today (or raced)

    const message = await this._buildMessage(user, snapshot, period, pending, completed, tasks);
    if (!message) return;

    await telegramClient.sendMessage(this.bot, user.telegram_id, message, {
      parse_mode: 'Markdown',
    });
    this.sentGuard.add(guardKey);
    logger.info(`[CheckinCron] Sent ${period} check-in to ${user.telegram_id}`);
  }

  async _buildMessage(user, snapshot, period, pending, completed, tasks) {
    // Evening with everything done → celebrate, don't interrogate.
    if (period === 'evening' && tasks.length > 0 && pending.length === 0) {
      const name = user.first_name || 'there';
      const streak = (user.current_streak || 0) + 1;
      return (
        `🌙 All ${tasks.length} tasks done today, ${name} — clean sweep.\n\n` +
        `🔥 That puts your streak at ${streak} day${streak === 1 ? '' : 's'}. ` +
        `Rest well — tomorrow's plan arrives in the morning.`
      );
    }

    // Everything else goes through the engine (momentum / recovery /
    // burnout prevention / goal reconnect / evening reflection / revival).
    const { text } = await checkinEngine.generate(user, snapshot, period);
    if (!text) return null;

    // Ground the message in the actual task state so it's about TASKS,
    // not generic motivation.
    if (period === 'midday' && pending.length > 0) {
      const list = pending.slice(0, 3)
        .map((t) => `  ▫️ ${t.title}`)
        .join('\n');
      const more = pending.length > 3 ? `\n  …and ${pending.length - 3} more` : '';
      return `${text}\n\n📋 Still open today:\n${list}${more}\n\nTap /start to knock one out.`;
    }
    if (period === 'evening' && pending.length > 0) {
      return `${text}\n\n${completed.length}/${tasks.length} done so far — ${pending.length} left. Even one more counts. /start`;
    }
    return text;
  }
}

const checkinCron = new CheckinCron();

module.exports = { checkinCron, CheckinCron };
