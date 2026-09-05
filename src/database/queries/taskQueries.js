// src/database/queries/taskQueries.js
//
// Calendar dates in this file are the USER'S local day, never the server's.
// assigned_date / due_date are DATE columns holding a user-local day, so any
// function that touches them takes the date from its caller. There used to be
// `date = null` defaults that fell back to `new Date().toISOString()` — raw UTC
// — which meant a write from a caller with the right timezone could be read
// back by a query using the server's day and come up empty.
const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

// A missing date is a bug in the caller, not something to paper over with the
// server's own day. Throwing surfaces it at the call site instead of returning
// a plausible-looking wrong answer.
function requireDate(date, fnName) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      `${fnName}: a user-local YYYY-MM-DD date is required (got ${JSON.stringify(date)}). ` +
      'Use timezoneUtils.getLocalDateString(user.timezone).'
    );
  }
  return date;
}

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
      assigned_date: requireDate(task.assigned_date, 'createTasks(assigned_date)'),
      due_date: requireDate(task.due_date || task.assigned_date, 'createTasks(due_date)'),
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

  async getDailyTasks(userId, date) {
    const targetDate = requireDate(date, 'getDailyTasks');

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
  async getSkippedTasks(userId, date) {
    const targetDate = requireDate(date, 'getSkippedTasks');

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

  // Skipped-but-still-active tasks skipped within the last `days` days. Keys
  // off updated_at (bumped by every skip), NOT assigned_date: a user who skips
  // a carried-over task from an earlier day still expects to see it in
  // /skipped. updated_at is an absolute UTC instant, so this is timezone-safe —
  // no user-local calendar-day drift like assigned_date has. Newest skip first.
  // Backs the /skipped command.
  async getRecentlySkippedTasks(userId, days = 3) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('is_active', true)
      .eq('user_id', userId)
      .eq('status', 'skipped')
      .gte('updated_at', cutoff)
      .order('updated_at', { ascending: false });

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
      .maybeSingle();

    // maybeSingle() returns null data (no error) when no row matches, so
    // callers can rely on a falsy return for "task not found" instead of
    // this throwing PGRST116 and skipping their guard.
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

  // Roll every still-active, still-pending task dated BEFORE `toDate` forward
  // onto `toDate`. Backs the "Keep them — I'll finish later" decision: carried-
  // over tasks are dated in the past, but day-scoped reads (getDailyTasks, used
  // by /start and show-tasks) only match today's date — so without re-dating,
  // kept tasks stay alive but invisible. assigned_date + due_date move together
  // (mirrors the reschedule/simplified-task paths) so day-scoped queries stay
  // consistent. Returns the number of tasks moved.
  async rollPendingForwardTo(userId, toDate) {
    const { data, error } = await supabase
      .from('tasks')
      .update({
        assigned_date: toDate,
        due_date: toDate,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('is_active', true)
      .eq('status', 'pending')
      .lt('assigned_date', toDate)
      .select('id');

    if (error) throw error;
    return (data || []).length;
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
  
  // The calendar day, IN THE USER'S TIMEZONE, of their most recent completion.
  // completed_at is an absolute instant, so slicing its ISO string yields the
  // UTC day — which both callers then diff against a user-local "today",
  // producing an off-by-one day gap near either end of the day. Converting the
  // instant into the user's zone makes both sides of that subtraction the same
  // kind of thing.
  async getLastCompletionDate(userId, timezone = 'UTC') {
    const { data } = await supabase
      .from('tasks')
      .select('completed_at')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .single();
    if (!data?.completed_at) return null;
    const timezoneUtils = require('../../utils/timezoneUtils');
    return timezoneUtils.getLocalDateString(timezone, new Date(data.completed_at));
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
    

// requireDate is attached to the exported object so the BUG-001 date guard can
// be unit-tested directly (scripts/test-date-handling.js). It is a pure helper;
// exposing it changes no query behaviour.
taskQueries.requireDate = requireDate;

module.exports = taskQueries;