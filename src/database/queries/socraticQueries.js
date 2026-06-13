// src/database/queries/socraticQueries.js
const { supabase } = require('../../config/supabase');

const socraticQueries = {
  async createLog({
    userId,
    taskId,
    question,
    followUpRequired = false,
    followUpQuestion = null,
    followUpDepth = 0,
    parentLogId = null,
  }) {
    const { data, error } = await supabase
      .from('socratic_logs')
      .insert({
        user_id: userId,
        task_id: taskId,
        question,
        follow_up_required: followUpRequired,
        follow_up_question: followUpQuestion,
        follow_up_depth: followUpDepth,
        parent_log_id: parentLogId,
        awaiting_response: true,
      })
      .select()
      .single();

    if (error) throw error;

    return data;
  },

  async getPendingLogs(userId) {
    const { data, error } = await supabase
      .from('socratic_logs')
      .select('*')
      .eq('user_id', userId)
      .eq('follow_up_required', true)
      .is('user_response', null)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  async getUnansweredLogs(userId) {
    const { data, error } = await supabase
      .from('socratic_logs')
      .select('*')
      .eq('user_id', userId)
      .is('user_response', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) throw error;
    return data || [];
  },

  async clearAwaitingResponse(userId) {
    const { error } = await supabase
      .from('socratic_logs')
      .update({ 
        user_response: '[skipped]',
        understanding_level: 'none',
        follow_up_required: false,
      })
      .eq('user_id', userId)
      .is('user_response', null);

    if (error) throw error;
  },

  async updateLog(logId, updates) {
    const { data, error } = await supabase
      .from('socratic_logs')
      .update(updates)
      .eq('id', logId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // FIX 10: Atomic update — only if still unanswered
  async updateLogIfUnanswered(logId, updates) {
    const { data, error } = await supabase
      .from('socratic_logs')
      .update(updates)
      .eq('id', logId)
      .is('user_response', null)
      .select('id')
      .single();

    return !error && data !== null ? data : null;
  },

  // FIX 10: Get log by ID for dedup check
  async getLogById(logId) {
    const { data } = await supabase
      .from('socratic_logs')
      .select('*')
      .eq('id', logId)
      .single();

    return data;
  },

  async getRecentLogs(userId, limit = 5) {
    const { data, error } = await supabase
      .from('socratic_logs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  },

  async deleteUserLogs(userId) {
    const { error } = await supabase
      .from('socratic_logs')
      .delete()
      .eq('user_id', userId);
    if (error) throw error;
  },
};

module.exports = socraticQueries;