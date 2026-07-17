// src/database/queries/userQueries.js
const { supabase } = require('../../config/supabase');

const userQueries = {
  async createUser(telegramId, userData) {
    const { data, error } = await supabase
      .from('users')
      .upsert({
        telegram_id: telegramId,
        username: userData.username,
        first_name: userData.first_name,
        last_name: userData.last_name,
        last_active: new Date().toISOString().split('T')[0],
      }, { onConflict: 'telegram_id' })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async getUserByTelegramId(telegramId) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  async getAllActiveUsers() {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('onboarding_completed', true)
      .eq('is_active', true); // blocked/deactivated users were processed forever

    if (error) throw error;
    return data || [];
  },

  /**
   * Mark a user inactive when Telegram tells us they're unreachable
   * (blocked the bot / deleted their account). Returns true if deactivated.
   */
  async deactivateIfUnreachable(userId, err) {
    const desc = (err && (err.description || err.message)) || '';
    if (!desc.includes('bot was blocked') && !desc.includes('user is deactivated') && !desc.includes('chat not found')) {
      return false;
    }
    const { error } = await supabase
      .from('users')
      .update({ is_active: false })
      .eq('id', userId);
    if (error) throw error;
    return true;
  },

  async updateOnboardingState(telegramId, state, data = {}) {
    const updates = {
      onboarding_state: state,
      ...data,
      last_active: new Date().toISOString().split('T')[0],
    };

    if (state === 'completed') {
      updates.onboarding_completed = true;
    }

    const { data: user, error } = await supabase
      .from('users')
      .update(updates)
      .eq('telegram_id', telegramId)
      .select()
      .single();

    if (error) throw error;
    return user;
  },

  async updateStreak(userId, increment = true) {
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('current_streak, longest_streak')
      .eq('id', userId)
      .single();

    if (fetchError) throw fetchError;

    let newStreak = increment ? user.current_streak + 1 : 0;
    let longestStreak = user.longest_streak;

    if (newStreak > longestStreak) {
      longestStreak = newStreak;
    }

    const { data, error } = await supabase
      .from('users')
      .update({
        current_streak: newStreak,
        longest_streak: longestStreak,
        last_active: new Date().toISOString().split('T')[0],
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async resetStreak(userId) {
    const { data, error } = await supabase
      .from('users')
      .update({
        current_streak: 0,
        last_active: new Date().toISOString().split('T')[0],
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async markTasksSentToday(userId, date) {
    const { data, error } = await supabase
      .from('users')
      .update({
        last_tasks_sent_date: date,
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async getInactiveUsers(days = 3) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('is_active', true)
      .eq('onboarding_completed', true)
      .lte('last_active', cutoffDate.toISOString().split('T')[0]);

    if (error) throw error;
    return data || [];
  },

  async updateUserGoals(telegramId, goals) {
    const { data, error } = await supabase
      .from('users')
      .update({
        goal: goals.join(', ')
      })
      .eq('telegram_id', telegramId);

    if (error) {
      throw error;
    }

    return data;
  },

  async resetUser(userId) {
    const { data, error } = await supabase
      .from('users')
      .update({
        goal: null,
        deadline: null,
        available_time: null,
        motivation: null,
        biggest_struggle: null,
        personality_type: null,
        current_streak: 0,
        longest_streak: 0,
        onboarding_completed: false,
        onboarding_state: 'goal',
        // Everything below was previously left stale, so a re-onboarded user
        // kept their old roadmap/mode and skipped several onboarding steps.
        task_mode: null,
        roadmap: null,
        roadmap_json: null,
        life_struggle: null,
        domain_knowledge: null,
        preferred_time: null,
        start_preference: null,
        progressive_onboarding_step: 0,
        last_progressive_question_date: null,
        last_tasks_sent_date: null,
        last_morning_question_date: null,
        daily_task_preference: null,
        // timezone intentionally KEPT — the user's location didn't change.
      })
      .eq('id', userId)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  async saveProgressiveAnswer(telegramId, field, value) {
    const allowedFields = ['biggest_struggle', 'domain_knowledge', 'motivation', 'life_struggle', 'roadmap'];
    if (!allowedFields.includes(field)) throw new Error(`Invalid progressive field: ${field}`);

    const { data, error } = await supabase
      .from('users')
      .update({ [field]: value })
      .eq('telegram_id', telegramId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async incrementProgressiveStep(telegramId) {
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('progressive_onboarding_step')
      .eq('telegram_id', telegramId)
      .single();

    if (fetchError) throw fetchError;

    return this.setProgressiveStep(telegramId, (user.progressive_onboarding_step || 0) + 1);
  },

  async setProgressiveStep(telegramId, step) {
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('users')
      .update({
        progressive_onboarding_step: step,
        last_progressive_question_date: today,
      })
      .eq('telegram_id', telegramId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // FIX 7: Atomic progressive question date setter
  async trySetProgressiveQuestionDate(telegramId, date) {
    const { data, error } = await supabase
      .from('users')
      .update({ last_progressive_question_date: date })
      .eq('telegram_id', telegramId)
      .or(`last_progressive_question_date.is.null,last_progressive_question_date.neq.${date}`)
      .select('id')
      .single();

    return !error && data !== null;
  },
  async saveRoadmapJson(telegramId, roadmapJson) {
    const { data, error } = await supabase
      .from('users')
      .update({ roadmap_json: roadmapJson })
      .eq('telegram_id', telegramId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },
};

module.exports = userQueries;