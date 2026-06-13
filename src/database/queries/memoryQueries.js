// src/database/queries/memoryQueries.js
const { supabase } = require('../../config/supabase');

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
    await supabase
      .from('memory')
      .update({ is_active: false })
      .eq('user_id', userId)
      .eq('is_active', true);

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
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateMemory(memoryId, updates) {
    const { data, error } = await supabase
      .from('memory')
      .update(updates)
      .eq('id', memoryId)
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