// src/database/queries/checkinQueries.js
const { supabase } = require('../../config/supabase');

const checkinQueries = {
 async createCheckin(userId, checkinData) {
    const { data, error } = await supabase
      .from('checkins')
      .upsert({
        user_id: userId,
        date: new Date().toISOString().split('T')[0],
        checkin_type: checkinData.type,
        response: checkinData.response,
        mood_rating: checkinData.mood_rating,
      }, { onConflict: 'user_id,date,checkin_type', ignoreDuplicates: true })
      .select()
      .single();

    // ignoreDuplicates returns null data — not an error
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  async getTodayCheckin(userId, type = null) {
    let query = supabase
      .from('checkins')
      .select('*')
      .eq('user_id', userId)
      .eq('date', new Date().toISOString().split('T')[0]);

    if (type) {
      query = query.eq('checkin_type', type);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async getConsecutiveMisses(userId) {
    const { data, error } = await supabase
      .from('checkins')
      .select('date')
      .eq('user_id', userId)
      .eq('checkin_type', 'daily')
      .order('date', { ascending: false })
      .limit(1);

    if (error) throw error;

    if (data.length === 0) return 0;

    const lastCheckin = new Date(data[0].date);
    const today = new Date();
    const diffTime = Math.abs(today - lastCheckin);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    return diffDays;
  },

  async deleteUserCheckins(userId) {
    const { error } = await supabase
      .from('checkins')
      .delete()
      .eq('user_id', userId);
    if (error) throw error;
  },
};

module.exports = checkinQueries;