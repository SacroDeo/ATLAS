// src/database/queries/memoryQueries.js
const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

const memoryQueries = {
  async getActiveMemory(userId) {
    const { data, error } = await supabase
      .from('memory')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  },

  async createMemory(userId, memoryData) {
    // Insert the NEW active row FIRST, then deactivate the older ones. The old
    // order (deactivate-then-insert) left the user with ZERO active memory rows
    // whenever the insert failed. Insert-first means a failed insert leaves the
    // previous memory intact, and a failed deactivate leaves two active rows —
    // harmless, because getActiveMemory orders by created_at DESC limit 1 and
    // returns the new one regardless (BUG-026).
    const { data, error } = await supabase
      .from('memory')
      .insert({
        user_id: userId,
        summary: memoryData.summary,
        strengths: memoryData.strengths,
        weaknesses: memoryData.weaknesses,
        patterns: memoryData.patterns,
        strategies: memoryData.strategies,
        excuses: memoryData.excuses,
        token_count: memoryData.token_count,
        version: memoryData.version || 1,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;

    // Deactivate every OTHER active row for this user. Best-effort: a failure
    // here is non-fatal (see note above), so log and continue rather than throw
    // away the memory we just created.
    const { error: deactivateError } = await supabase
      .from('memory')
      .update({ is_active: false })
      .eq('user_id', userId)
      .eq('is_active', true)
      .neq('id', data.id);

    if (deactivateError) {
      logger.warn(`createMemory: could not deactivate old memory rows for user ${userId}: ${deactivateError.message}`);
    }

    return data;
  },

  async updateMemory(memoryId, userId, updates) {
    // Scope by BOTH id AND user_id so this can never update another user's
    // memory row, even if a future caller passes an id it didn't derive from
    // this user (BUG-024). There is no in-tree caller today, but a multi-tenant
    // update must be user-scoped by construction, not by caller discipline.
    const { data, error } = await supabase
      .from('memory')
      .update(updates)
      .eq('id', memoryId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async getMemoryHistory(userId, limit = 5) {
    const { data, error } = await supabase
      .from('memory')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  },

  async deleteUserMemory(userId) {
    const { error } = await supabase
      .from('memory')
      .delete()
      .eq('user_id', userId);
    if (error) throw error;
  },
};

module.exports = memoryQueries;