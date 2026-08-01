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
      source: task.source || 'ai', // 'manual' | 'ai' — needed to recall what user wrote vs what AI generated
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

  // Skipped-but-still-active tasks for a given day. Skipping only sets
  // status='skipped' (is_active stays true), so these are fully preserved
  // and can be restored to 'pending'. Used by the /skipped command.
  async getSkippedTasks(userId, date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('is_active', true)
      .eq('user_id', userId)
      .eq('assigned_date', targetDate)
      .eq('status', 'skipped')
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  // Skipped-but-still-active tasks across a date window [startDate, endDate]
  // (both inclusive). Dates are USER-LOCAL calendar days — assigned_date is
  // stored user-local, so callers must pass dates derived from timezoneUtils,
  // never a raw UTC toISOString(). Backs the /skipped command's 3-day window so
  // users can revisit tasks skipped on earlier days, not just today.
  async getSkippedTasksInRange(userId, startDate, endDate) {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('is_active', true)
      .eq('user_id', userId)
      .eq('status', 'skipped')
      .gte('assigned_date', startDate)
      .lte('assigned_date', endDate)
      .order('assigned_date', { ascending: true })
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

  // userId is optional for backward-compat but SHOULD always be passed:
  // when present the update is scoped to the owner, so a stray/forged taskId
  // can never modify another user's task (defense-in-depth — callers already
  // pre-select from the user's own tasks, this is the second lock).
  async updateTask(taskId, updates, userId = null) {
    let q = supabase.from('tasks').update(updates).eq('id', taskId);
    if (userId != null) q = q.eq('user_id', userId);
    const { data, error } = await q.select().single();
    if (error) throw error;
    return data;
  },

  async deleteTask(taskId, userId = null) {
    let q = supabase.from('tasks').delete().eq('id', taskId);
    if (userId != null) q = q.eq('user_id', userId);
    const { error } = await q;
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

async deactivateActiveTasks(userId, date = null) {
  const targetDate = date || new Date().toISOString().split('T')[0];

  const { error } = await supabase
    .from('tasks')
    .update({
      is_active: false
    })
    .eq('user_id', userId)
    .eq('assigned_date', targetDate)
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
      .eq('is_active', true)
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


    async getPendingTasksBefore(userId, beforeDate) {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .eq('status', 'pending')
      .lt('assigned_date', beforeDate)
      .order('assigned_date', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  // All still-pending, still-active tasks up to AND including `date` —
  // i.e. today's unfinished tasks plus any leftover from earlier days.
  // Used to decide whether to interrupt task generation with a keep/skip prompt.
  async getActivePendingUpTo(userId, date) {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .eq('status', 'pending')
      .lte('assigned_date', date)
      .order('assigned_date', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  // Deactivate every still-pending task up to and including `date`.
  // Deactivated tasks fall out of every is_active=true query (today's list,
  // progress, streak), so they stay NEUTRAL — they neither count as completed
  // nor break the streak. This is the "skip old tasks & get new ones" path.
  async clearPendingForRegeneration(userId, date) {
    const { error } = await supabase
      .from('tasks')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('is_active', true)
      .eq('status', 'pending')
      .lte('assigned_date', date);

    if (error) throw error;
    return true;
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

  // Check if user completed at least one task on a specific date
  async hasCompletedTasksOnDate(userId, date) {
    const { count } = await supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('assigned_date', date)
      .eq('status', 'completed');
    return count > 0;
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
      .eq('is_active', true)
      .gte('assigned_date', startDate)
      .lte('assigned_date', endDate)
      .order('assigned_date', { ascending: true });

    if (error) throw error;
    return data || [];
  },
  async getRecentManualTaskTitles(userId, limit = 30) {
    const { data, error } = await supabase
      .from('tasks')
      .select('title, assigned_date')
      .eq('user_id', userId)
      .eq('source', 'manual')
      .order('assigned_date', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data || []).reverse(); // chronological, oldest first
  },
 async createTasksIfNotExists(userId, date, tasks) {
  const { error: lockError } = await supabase
    .from('task_generation_locks')
    .insert({ user_id: userId, assigned_date: date });

  if (lockError) {
    if (lockError.code === '23505') {
      // Lock exists — check if tasks actually exist
      const existing = await this.getDailyTasks(userId, date);
      if (existing.length > 0) {
        logger.info(`[createTasksIfNotExists] Lock held and tasks exist for ${userId} on ${date}`);
        return { inserted: false, tasks: existing };
      }

      // No tasks yet — the holder may still be MID-GENERATION (AI calls take
      // ~10-30s). Only treat the lock as stale once it's genuinely old;
      // clearing a live lock made both callers insert duplicate task sets.
      const { data: lockRow } = await supabase
        .from('task_generation_locks')
        .select('created_at')
        .eq('user_id', userId)
        .eq('assigned_date', date)
        .maybeSingle();

      const lockAgeMs = lockRow
        ? Date.now() - new Date(lockRow.created_at).getTime()
        : Infinity;
      const STALE_AFTER_MS = 3 * 60 * 1000;

      if (lockAgeMs < STALE_AFTER_MS) {
        logger.info(`[createTasksIfNotExists] Lock held ${Math.round(lockAgeMs / 1000)}s for ${userId} on ${date} — generation in progress, backing off`);
        return { inserted: false, tasks: [] };
      }

      // Genuinely stale (crashed mid-generation) — delete it and retry
      logger.warn(`[createTasksIfNotExists] Stale lock (${Math.round(lockAgeMs / 1000)}s) for ${userId} on ${date} — clearing and retrying`);
      await supabase
        .from('task_generation_locks')
        .delete()
        .eq('user_id', userId)
        .eq('assigned_date', date);

      const { error: retryLockError } = await supabase
        .from('task_generation_locks')
        .insert({ user_id: userId, assigned_date: date });

      if (retryLockError) {
        // Someone else re-acquired first — yield to them.
        if (retryLockError.code === '23505') {
          return { inserted: false, tasks: await this.getDailyTasks(userId, date) };
        }
        throw retryLockError;
      }
    } else {
      throw lockError;
    }
  }

  try {
    const inserted = await this.createTasks(userId, tasks);
    return { inserted: true, tasks: inserted };
  } catch (insertError) {
    await supabase
      .from('task_generation_locks')
      .delete()
      .eq('user_id', userId)
      .eq('assigned_date', date);
    throw insertError;
  }
},
};
    

module.exports = taskQueries;