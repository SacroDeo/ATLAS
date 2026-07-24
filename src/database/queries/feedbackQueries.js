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
};

module.exports = feedbackQueries;
