// src/bot/commands/feedbackCommands.js
// Beta feedback pipeline:
//   /feedback <text>  — any user; saved to Supabase AND forwarded to admin DM
//                       instantly, so the founder sees it in real time.
//   /betastats        — admin only; live beta health numbers from the DB.
const config = require('../../config');
const feedbackQueries = require('../../database/queries/feedbackQueries');
const telegramClient = require('../../utils/telegram/telegramClient');
const logger = require('../../utils/logger');

function adminId() {
  return config.telegram.adminId || process.env.ADMIN_TELEGRAM_ID;
}

const feedbackCommands = {
  async handleFeedback(bot, chatId, telegramId, args, user) {
    const text = (args || '').trim();
    if (!text) {
      await telegramClient.sendMessage(bot, chatId,
        '💬 Tell me what to pass on!\n\nUsage: /feedback your thoughts here\n\n' +
        'Bugs, annoyances, ideas, praise — everything helps ATLAS get better.');
      return;
    }
    // Live identity from Telegram itself — the DB row's username can be null
    // or stale (set once at signup); getChat is always current.
    let username = (user && user.username) || null;
    let displayName = '';
    try {
      const chat = await bot.getChat(telegramId);
      username = chat.username || username;
      displayName = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
    } catch { /* keep DB fallback */ }
    const row = await feedbackQueries.addFeedback(telegramId, username, text);

    // Real-time forward to the founder's own Telegram. Also fires when the
    // admin tests /feedback themselves, so the pipeline is visibly working.
    const admin = adminId();
    if (admin) {
      const who = [
        displayName || null,
        username ? `@${username}` : null,
        `id:${telegramId}`,
      ].filter(Boolean).join(' · ');
      try {
        await telegramClient.sendMessage(bot, admin,
          `📣 *Feedback #${row.id}*\nFrom: ${who}\n\n${text}`,
          { parse_mode: 'Markdown' });
      } catch (err) {
        logger.warn('Feedback admin forward failed:', err.message);
      }
    }
    await telegramClient.sendMessage(bot, chatId,
      '🙏 Got it — sent straight to the builder. Thank you for shaping ATLAS!');
  },

  // /guide — the detailed how-to-use manual, inside the bot itself.
  // Plain Markdown (not V2) to avoid escaping every punctuation mark.
  async handleGuide(bot, chatId) {
    await telegramClient.sendMessage(bot, chatId,
      `📖 *How to use ATLAS — the full guide*\n\n` +

      `*1️⃣ Getting started*\n` +
      `Press /start and answer the onboarding questions — your goal, your level, ` +
      `when you want your tasks each morning. ATLAS builds you a roadmap and starts coaching.\n\n` +

      `*2️⃣ Your daily loop*\n` +
      `• Every morning (your timezone) ATLAS sends your tasks for the day\n` +
      `• Tap /start anytime to see them as ✅ buttons — tap to complete\n` +
      `• /today shows what's left, /progress shows today's completion + streak\n` +
      `• Complete tasks daily to build your 🔥 streak — ATLAS notices when you slip\n\n` +

      `*3️⃣ Just talk to it*\n` +
      `No commands needed — type naturally:\n` +
      `_"add a task to revise SQL joins"_ · _"delete task 3"_ · _"show my goal"_ · ` +
      `_"I'm feeling stuck today"_\n` +
      `ATLAS understands, acts, and remembers your history across weeks.\n\n` +

      `*4️⃣ Reviews & stats*\n` +
      `• /stats — your week in numbers\n` +
      `• /review — AI retrospective of your week\n` +
      `• /roadmap — see or update your full learning roadmap\n\n` +

      `*5️⃣ Web dashboard*\n` +
      `/dashboard opens your charts in the browser (sign in with Telegram, or ` +
      `/linkweb to connect Google sign-in).\n\n` +

      `*6️⃣ Beta tester duties* 🏆\n` +
      `• Use ATLAS for real, most days\n` +
      `• Anything annoying, broken, or great → /feedback your thought — it lands ` +
      `directly with the builder\n` +
      `• Active testers earn *lifetime Pro, free, forever*\n\n` +

      `⚠️ /reset wipes your profile and goal — only if you want to start over.\n\n` +
      `Full command list: /help`,
      { parse_mode: 'Markdown' });
  },

  async handleBetaStats(bot, chatId, telegramId) {
    const admin = adminId();
    if (!admin || String(telegramId) !== String(admin)) return false; // silent for non-admins
    const s = await feedbackQueries.betaStats();
    const fb = await feedbackQueries.countFeedback();
    await telegramClient.sendMessage(bot, chatId,
      `📊 *ATLAS Beta Stats*\n\n` +
      `👥 Total users: *${s.total}*\n` +
      `✅ Finished onboarding: *${s.onboarded}*\n` +
      `🧪 Real beta testers: *${s.realUsers}* (excl. admin + founding)\n` +
      `🔥 Active today: *${s.activeToday}*\n` +
      `📅 Active this week: *${s.activeWeek}*\n` +
      `💬 Feedback received: *${fb}*`,
      { parse_mode: 'Markdown' });
    return true;
  },

  // /beta [days] — admin-only per-user monitor. Unlike /betastats (aggregate
  // counts), this ranks each real tester by GENUINE engagement so the founder
  // can decide who earns lifetime founding tier — WITHOUT rewarding gameable
  // "days active". See feedbackQueries.betaRoster() for why each signal is
  // hard to fake. Window defaults to 21 days (the ~3-week beta observation).
  async handleBetaRoster(bot, chatId, telegramId, args) {
    const admin = adminId();
    if (!admin || String(telegramId) !== String(admin)) return false; // silent for non-admins

    let days = parseInt((args || '').trim(), 10);
    if (!Number.isFinite(days) || days < 1 || days > 120) days = 21;

    const roster = await feedbackQueries.betaRoster(days);
    if (roster.length === 0) {
      await telegramClient.sendMessage(bot, chatId,
        `🧪 *Beta roster (last ${days}d)*\n\nNo real beta testers yet.`,
        { parse_mode: 'Markdown' });
      return true;
    }

    const esc = (s) => String(s || '').replace(/([*_`\[])/g, '\\$1');
    const lines = roster.map((r, i) => {
      const name = esc(r.firstName || r.username || `id:${r.telegramId}`);
      const handle = r.username ? ` (@${esc(r.username)})` : '';
      // Two lines per tester: identity + the effortful signals underneath.
      return (
        `${i + 1}. *${name}*${handle}\n` +
        `   🔥 ${r.currentStreak}d · 📅 ${r.daysActive} active · ✅ ${r.completionPct}% ` +
        `(${r.completed}/${r.assigned})\n` +
        `   ✍️ ${r.ownTasks} own · 💬 ${r.realMsgs} msgs · 📣 ${r.feedback} fb · ` +
        `🧠 ${r.deepSocratic} deep · ⭐ ${r.score}`
      );
    });

    // Telegram caps messages at 4096 chars — chunk so a large cohort never
    // silently truncates the tail (which would hide the least-engaged testers).
    const header = `🧪 *Beta roster — last ${days}d* (${roster.length} testers, ranked by genuine engagement)\n\n`;
    const legend =
      `\n\n_⭐ score = effort-weighted: own tasks & feedback count most, ` +
      `raw days active least. High days but low everything else = likely gaming._`;
    const chunks = [];
    let buf = header;
    for (const line of lines) {
      if ((buf + line + '\n\n').length > 3800) {
        chunks.push(buf.trimEnd());
        buf = '';
      }
      buf += line + '\n\n';
    }
    if (buf.trim()) chunks.push(buf.trimEnd());
    chunks[chunks.length - 1] += legend;

    for (const chunk of chunks) {
      await telegramClient.sendMessage(bot, chatId, chunk, { parse_mode: 'Markdown' });
    }
    return true;
  },
};

module.exports = { feedbackCommands };
