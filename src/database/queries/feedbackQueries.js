// src/database/queries/feedbackQueries.js
const { supabase } = require('../../config/supabase');

const feedbackQueries = {
  async addFeedback(telegramId, username, text) {
    const { data, error } = await supabase
      .from('feedback')
      .insert({ telegram_id: telegramId, username, text })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async countFeedback() {
    const { count, error } = await supabase
      .from('feedback')
      .select('*', { count: 'exact', head: true });
    if (error) throw error;
    return count || 0;
  },

  // Beta health numbers for /betastats — all from tables that already exist.
  // Excludes admin + founding-tier users (test accounts, not real beta testers).
  async betaStats() {
    const config = require('../../config');
    const adminId = config.telegram.adminId || process.env.ADMIN_TELEGRAM_ID;
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().split('T')[0];

    const [total, onboarded, activeToday, activeWeek, realUsers] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }),
      supabase.from('users').select('*', { count: 'exact', head: true })
        .eq('onboarding_completed', true),
      supabase.from('users').select('*', { count: 'exact', head: true })
        .eq('last_active', today),
      supabase.from('users').select('*', { count: 'exact', head: true })
        .gte('last_active', weekAgo),
      // Real beta testers = onboarded, not admin, not founding tier
      supabase.from('users').select('*', { count: 'exact', head: true })
        .eq('onboarding_completed', true)
        .neq('tier', 'founding')
        .neq('telegram_id', adminId || 0),
    ]);
    for (const r of [total, onboarded, activeToday, activeWeek, realUsers]) {
      if (r.error) throw r.error;
    }
    return {
      total: total.count || 0,
      onboarded: onboarded.count || 0,
      activeToday: activeToday.count || 0,
      activeWeek: activeWeek.count || 0,
      realUsers: realUsers.count || 0,
    };
  },

  // Per-user beta roster for /beta — the gaming-resistant monitor.
  //
  // Shows ALL real users (excl. admin + founding test accounts), with invited
  // beta testers (is_beta=true) tagged and sorted to the top. This lets the
  // founder both (a) judge tagged testers for founding-tier rewards, and (b)
  // discover strong ORGANIC users worth converting — one who isn't a tester but
  // out-engages them would be invisible if we filtered testers only.
  //
  // WHY these signals: rewarding raw "days active" invites greed-driven fake
  // usage (Goodhart's Law) — a tester logs in daily just to earn free premium,
  // giving us worthless retention data. So instead of one gameable number we
  // surface a spread of signals that are HARD to fake because faking them costs
  // real effort:
  //   • ownTasks   — tasks the user TYPED themselves (source='manual'). AI tasks
  //                  are free to accumulate; writing your own is intent.
  //   • realMsgs   — genuine typed messages (conversation_history role='user',
  //                  already garbage-filtered at write time). Talking to the bot
  //                  in your own words can't be button-mashed.
  //   • feedback   — unprompted /feedback submissions. Costly signal of care.
  //   • deepSocratic — socratic answers rated 'deep'/'moderate'. You can't fake
  //                  understanding to the evaluator.
  //   • completion% — completed / assigned over the window.
  //   • daysActive — kept for context, but read ALONGSIDE the above, never alone.
  //
  // Everything is scoped to a rolling `days` window and joins on the right key
  // (users.id for tasks/checkins/socratic/conversation; users.telegram_id for
  // feedback). Excludes admin + founding tier, same as betaStats().
  async betaRoster(days = 21) {
    const config = require('../../config');
    const adminId = config.telegram.adminId || process.env.ADMIN_TELEGRAM_ID;
    const sinceDate = new Date(Date.now() - days * 864e5).toISOString().split('T')[0];
    const sinceTs = new Date(Date.now() - days * 864e5).toISOString();

    // Real users only. Keep normal (non-beta) users in — they're tagged in the
    // output, not filtered out — so organic stars stay visible.
    let usersQ = supabase
      .from('users')
      .select('id, telegram_id, username, first_name, is_beta, current_streak, longest_streak, last_active, created_at')
      .eq('onboarding_completed', true)
      .neq('tier', 'founding');
    if (adminId) usersQ = usersQ.neq('telegram_id', adminId);
    const { data: users, error: usersErr } = await usersQ;
    if (usersErr) throw usersErr;
    if (!users || users.length === 0) return [];

    const userIds = users.map(u => u.id);
    const telegramIds = users.map(u => u.telegram_id);

    // Pull all window-scoped rows in parallel, then bucket in JS. This avoids
    // N+1 per-user round trips — one query per signal regardless of tester count.
    const [tasksR, convR, feedbackR, socraticR] = await Promise.all([
      supabase
        .from('tasks')
        .select('user_id, status, source, assigned_date')
        .in('user_id', userIds)
        .gte('assigned_date', sinceDate),
      supabase
        .from('conversation_history')
        .select('user_id, role, created_at')
        .in('user_id', userIds)
        .eq('role', 'user')
        .gte('created_at', sinceTs),
      supabase
        .from('feedback')
        .select('telegram_id, created_at')
        .in('telegram_id', telegramIds)
        .gte('created_at', sinceTs),
      supabase
        .from('socratic_logs')
        .select('user_id, understanding_level, created_at')
        .in('user_id', userIds)
        .gte('created_at', sinceTs),
    ]);
    for (const r of [tasksR, convR, feedbackR, socraticR]) {
      if (r.error) throw r.error;
    }

    // Bucket by owner key.
    const byUser = new Map(users.map(u => [u.id, {
      user: u,
      assigned: 0,
      completed: 0,
      ownTasks: 0,
      activeDates: new Set(),
      realMsgs: 0,
      feedback: 0,
      deepSocratic: 0,
    }]));
    const byTelegram = new Map(users.map(u => [String(u.telegram_id), u.id]));

    for (const t of tasksR.data || []) {
      const b = byUser.get(t.user_id);
      if (!b) continue;
      b.assigned += 1;
      if (t.status === 'completed') {
        b.completed += 1;
        b.activeDates.add(t.assigned_date); // a completed task = a genuinely engaged day
      }
      if (t.source === 'manual') b.ownTasks += 1;
    }
    for (const c of convR.data || []) {
      const b = byUser.get(c.user_id);
      if (b) b.realMsgs += 1;
    }
    for (const f of feedbackR.data || []) {
      const uid = byTelegram.get(String(f.telegram_id));
      const b = uid && byUser.get(uid);
      if (b) b.feedback += 1;
    }
    for (const s of socraticR.data || []) {
      const b = byUser.get(s.user_id);
      if (b && (s.understanding_level === 'deep' || s.understanding_level === 'moderate')) {
        b.deepSocratic += 1;
      }
    }

    // Shape rows + a composite "genuine engagement" score for sorting. The score
    // deliberately weights effortful signals over mere presence, so the tester
    // who talks, writes their own tasks, and gives feedback ranks above the one
    // who only logs in. NOT shown to users — purely to order the founder's view.
    return Array.from(byUser.values())
      .map(b => {
        const completionPct = b.assigned > 0
          ? Math.round((b.completed / b.assigned) * 100)
          : 0;
        const daysActive = b.activeDates.size;
        const score =
          b.realMsgs * 2 +
          b.ownTasks * 3 +
          b.feedback * 5 +
          b.deepSocratic * 2 +
          daysActive * 1 +
          completionPct * 0.1;
        return {
          telegramId: b.user.telegram_id,
          username: b.user.username,
          firstName: b.user.first_name,
          isBeta: !!b.user.is_beta,
          currentStreak: b.user.current_streak || 0,
          longestStreak: b.user.longest_streak || 0,
          lastActive: b.user.last_active,
          daysActive,
          assigned: b.assigned,
          completed: b.completed,
          completionPct,
          ownTasks: b.ownTasks,
          realMsgs: b.realMsgs,
          feedback: b.feedback,
          deepSocratic: b.deepSocratic,
          score: Math.round(score * 10) / 10,
        };
      })
      // Invited testers first (that's who /beta is primarily for), then by
      // genuine-engagement score within each group.
      .sort((a, b) => (Number(b.isBeta) - Number(a.isBeta)) || (b.score - a.score));
  },
};

module.exports = feedbackQueries;
