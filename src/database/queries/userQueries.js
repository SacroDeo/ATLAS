// src/database/queries/userQueries.js
//
// `last_active` is a DATE column holding the USER'S own local day — it is what
// /betastats counts as "active today" and what getInactiveUsers measures idle
// time against. Deriving it from the server's clock stamped tomorrow (or
// yesterday) for anyone whose local date differed from UTC, so a user who had
// just spoken to the bot could read as inactive, and vice versa.
const { supabase } = require('../../config/supabase');
const timezoneUtils = require('../../utils/timezoneUtils');

// Every writer below is low-frequency (onboarding steps, once-a-day streak and
// progressive-question updates), so one extra `select timezone` is cheaper than
// threading a timezone through ~25 call sites and getting it wrong in one.
async function localTodayFor(column, value) {
  const { data } = await supabase
    .from('users')
    .select('timezone')
    .eq(column, value)
    .maybeSingle();
  return timezoneUtils.getLocalDateString(data?.timezone || 'UTC');
}

const userQueries = {
  async createUser(telegramId, userData) {
    const { data, error } = await supabase
      .from('users')
      .upsert({
        telegram_id: telegramId,
        username: userData.username,
        first_name: userData.first_name,
        last_name: userData.last_name,
        // A brand-new user has no timezone yet (onboarding guesses it from the
        // Telegram language code a moment later), so UTC is the only thing
        // available here — but a RETURNING user keeps theirs.
        last_active: await localTodayFor('telegram_id', telegramId),
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
      // If this same call is what sets the timezone (onboarding does), honour
      // the incoming value rather than the row's pre-update one.
      last_active: data.timezone
        ? timezoneUtils.getLocalDateString(data.timezone)
        : await localTodayFor('telegram_id', telegramId),
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

  // Compare-and-swap with a bounded retry. The previous version read
  // current_streak, added 1 in JS, and wrote the sum back, so two completions
  // landing together both read N and both wrote N+1 and one increment vanished
  // (BUG-025). PostgREST cannot express `current_streak = current_streak + 1`,
  // and a Postgres function to do it would leave this code broken until that
  // migration reached the live database — so the write is guarded on the value
  // that was read instead. A racing writer moves current_streak, the guard then
  // matches zero rows, and we re-read and redo the arithmetic on the new value.
  // Same idiom as premiumQueries.revokeGroupBeta and redeemCoupon.
  async updateStreak(userId, increment = true) {
    const MAX_ATTEMPTS = 4;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const { data: user, error: fetchError } = await supabase
        .from('users')
        .select('current_streak, longest_streak, timezone')
        .eq('id', userId)
        .single();

      if (fetchError) throw fetchError;

      const newStreak = increment ? (user.current_streak || 0) + 1 : 0;
      const longestStreak = Math.max(user.longest_streak || 0, newStreak);

      let write = supabase
        .from('users')
        .update({
          current_streak: newStreak,
          longest_streak: longestStreak,
          last_active: timezoneUtils.getLocalDateString(user.timezone || 'UTC'),
        })
        .eq('id', userId);

      // The guard itself. `.eq` never matches NULL, so a null streak needs `.is`.
      write = user.current_streak === null
        ? write.is('current_streak', null)
        : write.eq('current_streak', user.current_streak);

      const { data, error } = await write.select().maybeSingle();

      if (error) throw error;
      if (data) return data; // row was still as we read it, so the write landed

      // Zero rows means someone changed current_streak between the read and the
      // write. Loop: read the new value and recompute from it.
    }

    throw new Error(
      `updateStreak: current_streak for user ${userId} moved under ${MAX_ATTEMPTS} ` +
        'consecutive read-modify-write attempts; refusing to overwrite it blindly'
    );
  },
  async resetStreak(userId) {
    const { data, error } = await supabase
      .from('users')
      .update({
        current_streak: 0,
        last_active: await localTodayFor('id', userId),
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
    // Compare each user's last_active against THEIR OWN today. A single
    // server-derived cutoff is off by a day for anyone far enough from UTC,
    // which on a 3-day threshold is a 33% error. Filter in JS — this has no
    // callers today and would only ever run once per cron tick.
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('is_active', true)
      .eq('onboarding_completed', true);

    if (error) throw error;
    return (data || []).filter(u => {
      if (!u.last_active) return true; // never active at all
      const cutoff = timezoneUtils.addDaysToDateString(
        timezoneUtils.getLocalDateString(u.timezone || 'UTC'),
        -days
      );
      return u.last_active <= cutoff;
    });
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

  // Consent bookkeeping — stored so we can prove agreement if ever needed.
  // Swallow-safe: schema may not have the column yet (pre-migration), and
  // consent must never block onboarding.
  async recordTermsAgreement(telegramId) {
    const { error } = await supabase
      .from('users')
      .update({ terms_agreed_at: new Date().toISOString() })
      .eq('telegram_id', telegramId);
    if (error) throw error;
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
    // last_progressive_question_date gates one question per LOCAL day, so a
    // UTC date could burn today's slot for tomorrow (or re-open one already
    // used) for any user whose day differs from the server's.
    const today = await localTodayFor('telegram_id', telegramId);

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