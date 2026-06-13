// src/database/queries/reviewQueries.js
const { supabase } = require('../../config/supabase');

const reviewQueries = {
  async createWeeklyReview(reviewData) {
    const { data, error } = await supabase
      .from('weekly_reviews')
      .insert(reviewData)
      .select()
      .maybeSingle();

    if (error) throw error;
    return data;
  },

  async getLatestReview(userId) {
    const { data, error } = await supabase
      .from('weekly_reviews')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  },

  async getReviewByWeek(userId, weekNumber) {
    const { data, error } = await supabase
      .from('weekly_reviews')
      .select('*')
      .eq('user_id', userId)
      .eq('week_number', weekNumber)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  },

  async deleteUserReviews(userId) {
    const { error } = await supabase
      .from('weekly_reviews')
      .delete()
      .eq('user_id', userId);
    if (error) throw error;
  },
};

module.exports = reviewQueries;