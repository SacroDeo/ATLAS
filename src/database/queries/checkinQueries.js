// src/database/queries/checkinQueries.js
//
// checkins.date is a DATE column holding the USER'S local calendar day. It is
// half of the UNIQUE(user_id, date, checkin_type) dedup key, so deriving it
// from the server's clock let one local day produce two rows (or silently
// collapse two days into one) for anyone whose day differs from UTC.
const { supabase } = require('../../config/supabase');
const timezoneUtils = require('../../utils/timezoneUtils');

// Same contract as taskQueries.requireDate: a missing date is a caller bug,
// not something to paper over with the server's own day.
function requireDate(date, fnName) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      `${fnName}: a user-local YYYY-MM-DD date is required (got ${JSON.stringify(date)}). ` +
      'Use timezoneUtils.getLocalDateString(user.timezone).'
    );
  }
  return date;
}

const checkinQueries = {
 async createCheckin(userId, checkinData) {
    const { data, error } = await supabase
      .from('checkins')
      .upsert({
        user_id: userId,
        date: requireDate(checkinData.date, 'createCheckin(date)'),
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

  // timezone is required, not optional-with-a-UTC-default: "today" is
  // meaningless without it and a silent default is how this bug started.
  async getTodayCheckin(userId, timezone, type = null) {
    let query = supabase
      .from('checkins')
      .select('*')
      .eq('user_id', userId)
      .eq('date', timezoneUtils.getLocalDateString(timezone || 'UTC'));

    if (type) {
      query = query.eq('checkin_type', type);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async getConsecutiveMisses(userId, timezone = 'UTC') {
    // Days in a row (ending yesterday) where the user HAD tasks but
    // completed none of them. The old version measured days since the last
    // task DELIVERY, which is ~0 for anyone receiving tasks — so the
    // "stuck" check-in never fired for exactly the users it was meant for.
    //
    // The day-walk below compares against assigned_date, which is stored as
    // the user's local day. Deriving these strings from the server's clock
    // meant the comparison could be off by one for the whole streak: a real
    // miss looked like "no tasks assigned" and the loop broke on day 1.
    const today = timezoneUtils.getLocalDateString(timezone);
    const since = timezoneUtils.addDaysToDateString(today, -14);

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

    let misses = 0;
    // Walk backwards day by day from yesterday; stop at the first day
    // with a completion or with no tasks assigned.
    for (let i = 1; i <= 14; i++) {
      const d = timezoneUtils.addDaysToDateString(today, -i);
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