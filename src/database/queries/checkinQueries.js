// src/database/queries/checkinQueries.js
const { supabase } = require('../../config/supabase');

const checkinQueries = {
 async createCheckin(userId, checkinData) {
    const { data, error } = await supabase
      .from('checkins')
      .upsert({
        user_id: userId,
        // Callers that know the user's local day should pass checkinData.date
        // (YYYY-MM-DD) — the server-UTC default is wrong for users whose
        // local date differs from UTC at send time.
        date: checkinData.date || new Date().toISOString().split('T')[0],
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
    // Days in a row (ending yesterday) where the user HAD tasks but
    // completed none of them. The old version measured days since the last
    // task DELIVERY, which is ~0 for anyone receiving tasks — so the
    // "stuck" check-in never fired for exactly the users it was meant for.
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('tasks')
      .select('assigned_date, status')
      .eq('user_id', userId)
      .gte('assigned_date', since)
      .order('assigned_date', { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) return 0;

    // Group by day → did any task get completed that day?
    const byDay = new Map();
    for (const t of data) {
      const day = byDay.get(t.assigned_date) || { any: false, completed: false };
      day.any = true;
      if (t.status === 'completed') day.completed = true;
      byDay.set(t.assigned_date, day);
    }

    const today = new Date().toISOString().split('T')[0];
    let misses = 0;
    // Walk backwards day by day from yesterday; stop at the first day
    // with a completion or with no tasks assigned.
    for (let i = 1; i <= 14; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
        .toISOString().split('T')[0];
      if (d === today) continue;
      const day = byDay.get(d);
      if (!day || !day.any) break;
      if (day.completed) break;
      misses++;
    }
    return misses;
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