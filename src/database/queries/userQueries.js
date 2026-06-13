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
      .eq('onboarding_completed', true);

    if (error) throw error;
    return data || [];
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

    const nextStep = (user.progressive_onboarding_step || 0) + 1;
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('users')
      .update({
        progressive_onboarding_step: nextStep,
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