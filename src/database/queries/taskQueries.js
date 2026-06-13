// src/database/queries/taskQueries.js
const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');
const taskQueries = {
  async createTasks(userId, tasks) {
    const tasksToInsert = tasks.map(task => ({
      is_active:
  task.is_active !== undefined
    ? task.is_active
    : true,
      user_id: userId,
      title: task.title,
      description: task.description,
      why_it_matters: task.why_it_matters,
      estimated_time: task.estimated_time,
      status: task.status || 'pending',
      assigned_date: task.assigned_date || new Date().toISOString().split('T')[0],
      due_date: task.due_date || new Date().toISOString().split('T')[0],
      difficulty_level: task.difficulty_level || 'medium',
      is_daily: task.is_daily !== undefined ? task.is_daily : true,
      is_socratic: task.is_socratic || false,
    }));

    const { data, error } = await supabase
      .from('tasks')
      .insert(tasksToInsert)
      .select();

    if (error) throw error;
    return data;
  },

  async getDailyTasks(userId, date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('is_active', true)
      .eq('user_id', userId)
      .eq('assigned_date', targetDate)
      .eq('is_daily', true)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  async updateTaskStatus(taskId, status, additionalData = {}) {
    const updates = {
      status,
      updated_at: new Date().toISOString(),
      ...additionalData,
    };

    if (status === 'completed') {
      updates.completed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', taskId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateTask(taskId, updates) {
    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', taskId)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async deleteTask(taskId) {

  const { error } = await supabase
    .from('tasks')
    .delete()
    .eq('id', taskId);

  if (error) throw error;

  return true;
},

  async deleteTasksBulk(userId, taskIds) {

  try {

    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('user_id', userId)
      .in('id', taskIds);

    if (error) throw error;

    return true;

  } catch (error) {

    logger.error('Bulk delete failed:', error);

    return false;
  }
},

async deactivateActiveTasks(userId) {

  const { error } = await supabase
    .from('tasks')
    .update({
      is_active: false
    })
    .eq('user_id', userId)
    .eq('is_active', true);

  if (error) throw error;

  return true;
},

  async deleteAllTasks(userId) {

  const { error } = await supabase
    .from('tasks')
    .update({
      is_active: false
    })
    .eq('user_id', userId)
    .eq('is_active', true);

  if (error) throw error;

  return true;
},

  async getTaskById(taskId) {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .single();

    if (error) throw error;
    return data;
  },

  async getWeeklyTasks(userId, weekStart, weekEnd) {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('is_active', true)
      .eq('user_id', userId)
      .gte('assigned_date', weekStart)
      .lte('assigned_date', weekEnd)
      .order('assigned_date', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  async getCompletionStats(userId, startDate, endDate) {
    const { data, error } = await supabase
      .from('tasks')
      .select('status, assigned_date')
      .eq('user_id', userId)
      .gte('assigned_date', startDate)
      .lte('assigned_date', endDate);

    if (error) throw error;

    const taskData = data || [];

    const stats = {
      total: taskData.length,
      completed: taskData.filter(t => t.status === 'completed').length,
      skipped: taskData.filter(t => t.status === 'skipped').length,
      too_hard: taskData.filter(t => t.status === 'too_hard').length,
      pending: taskData.filter(t => t.status === 'pending').length,
      completion_rate: taskData.length > 0 
        ? ((taskData.filter(t => t.status === 'completed').length / taskData.length) * 100).toFixed(2)
        : 0,
    };

    return stats;
  },

  async countIncompleteTasks(userId, date) {
  const { supabase } = require('../../config/supabase');

  const { count, error } = await supabase
    .from('tasks')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('assigned_date', date)
    .neq('status', 'completed');

  if (error) {
    throw error;
  }

  return count || 0;
},

  async deleteUserTasks(userId) {
    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('user_id', userId);
    if (error) throw error;
  },

  async deleteOldTasks(userId, beforeDate) {
    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('user_id', userId)
      .lt('assigned_date', beforeDate)
      .neq('status', 'pending');

    if (error) throw error;
    return true;
  },
  
  async getLastCompletionDate(userId) {
    const { data } = await supabase
      .from('tasks')
      .select('completed_at')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .single();
    return data?.completed_at?.split('T')[0] || null;
  },
  /**
   * Returns tasks for a date range ordered by assigned_date.
   * Used by engagementAnalyzer for consecutive missed day detection.
   * Includes ALL statuses (completed, skipped, too_hard, pending).
   */
  async getTasksInRange(userId, startDate, endDate) {
    const { data, error } = await supabase
      .from('tasks')
      .select('id, status, assigned_date, completed_at, due_date')
      .eq('user_id', userId)
      .gte('assigned_date', startDate)
      .lte('assigned_date', endDate)
      .order('assigned_date', { ascending: true });

    if (error) throw error;
    return data || [];
  },
};
    

module.exports = taskQueries;