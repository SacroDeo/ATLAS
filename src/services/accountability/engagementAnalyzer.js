// src/services/accountability/engagementAnalyzer.js
// Pure analytics — NO AI calls, NO LLM usage.
// Calculates engagement level, burnout risk, streak risk, consistency trend,
// AND the new dynamic engagement score (0–100), burnout detection, relapse detection.

const taskQueries = require('../../database/queries/taskQueries');
const logger = require('../../utils/logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const INACTIVITY_THRESHOLDS = {
  MILD:     18,   // hours
  MODERATE: 36,   // hours
  SEVERE:   72,   // hours
};

const WINDOW_DAYS = 7;

// ─── Scoring weights (must sum to 100 when all factors are perfect) ───────────
const SCORE_WEIGHTS = {
  completionRate:   35,   // biggest positive driver
  streakHealth:     20,   // streak consistency
  onTimeRate:       10,   // completes tasks before due
  inactivityPenalty: 20,  // deducted for inactivity
  skipPenalty:       10,  // deducted for skipped tasks
  tooHardPenalty:    5,   // deducted for too_hard feedback
};

// ─── Engagement state thresholds ─────────────────────────────────────────────
const ENGAGEMENT_STATES = {
  HIGH_MOMENTUM: 80,
  STABLE:        60,
  FRAGILE:       40,
  // below 40 → 'disengaging'
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hoursSince(isoTimestamp) {
  if (!isoTimestamp) return Infinity;
  return (Date.now() - new Date(isoTimestamp).getTime()) / (1000 * 60 * 60);
}

function safeDivide(numerator, denominator) {
  if (!denominator || denominator === 0) return 0;
  return numerator / denominator;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

// ─── Core Analyzer ────────────────────────────────────────────────────────────

const engagementAnalyzer = {

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — NEW METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * calculateEngagementScore(userId)
   * Returns a numeric score 0–100 based on recent behavioral signals.
   * Higher = more engaged. Designed to run once daily per user.
   *
   * @param {Object} user  - Full user row from DB (needs id, telegram_id, current_streak, longest_streak, last_active)
   * @returns {number}     - Score 0–100 (integer)
   */
  async calculateEngagementScore(user) {
    try {
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - WINDOW_DAYS);
      const windowStartStr = windowStart.toISOString().split('T')[0];
      const today = new Date().toISOString().split('T')[0];

      const tasks = await taskQueries.getWeeklyTasks(user.id, windowStartStr, today);
      const m = this._computeMetrics(tasks, user);

      // ── Positive contributions ──────────────────────────────────────────────
      const completionContrib = m.completionRate * SCORE_WEIGHTS.completionRate;
      const streakContrib     = m.streakHealthRatio * SCORE_WEIGHTS.streakHealth;
      const onTimeContrib     = m.onTimeRate * SCORE_WEIGHTS.onTimeRate;

      // ── Inactivity penalty (linear scale over SEVERE threshold) ─────────────
      // 0h → 0 penalty | >= SEVERE (72h) → full penalty
      const inactivityRatio   = clamp(m.inactivityHours / INACTIVITY_THRESHOLDS.SEVERE, 0, 1);
      const inactivityPenalty = inactivityRatio * SCORE_WEIGHTS.inactivityPenalty;

      // ── Skip & too_hard penalties ─────────────────────────────────────────────
      const skipPenalty     = m.skipRate    * SCORE_WEIGHTS.skipPenalty;
      const tooHardPenalty  = m.tooHardRate * SCORE_WEIGHTS.tooHardPenalty;

      // ── Missed days penalty (days in window with zero activity) ───────────────
      const missedDaysPenalty = this._missedDaysPenalty(tasks);

      const rawScore = completionContrib + streakContrib + onTimeContrib
                     - inactivityPenalty - skipPenalty - tooHardPenalty
                     - missedDaysPenalty;

let score = Math.round(clamp(rawScore, 0, 100));

/**
 * Score floor protection.
 * Prevents decent users from being classified as "disengaging"
 * too aggressively after small dips.
 */

// If user is completing at least half their tasks,
// don't allow score to collapse too low.
if (m.completionRate >= 0.5 && score < 45) {
  score = 45;
}

// Users with meaningful streaks deserve stability buffering.
if ((user.current_streak || 0) >= 7 && score < 55) {
  score = 55;
}

// Highly consistent users shouldn't suddenly look disengaged.
if (m.completionRate >= 0.8 && score < 70) {
  score = 70;
}
      logger.info(
        `[EngagementScore] User ${user.telegram_id}: score=${score} | ` +
        `completion=${completionContrib.toFixed(1)}, streak=${streakContrib.toFixed(1)}, ` +
        `onTime=${onTimeContrib.toFixed(1)}, inactivityPenalty=${inactivityPenalty.toFixed(1)}, ` +
        `skipPenalty=${skipPenalty.toFixed(1)}, tooHardPenalty=${tooHardPenalty.toFixed(1)}, ` +
        `missedDaysPenalty=${missedDaysPenalty.toFixed(1)}`
      );

      return score;
    } catch (error) {
      logger.error(`[EngagementScore] Failed for user ${user.telegram_id}:`, error);
      return 50; // neutral fallback — never crash caller
    }
  },

  /**
   * getEngagementState(score)
   * Maps a numeric score to a named state.
   *
   * @param {number} score  - 0–100
   * @returns {string}      - 'high_momentum' | 'stable' | 'fragile' | 'disengaging'
   */
  getEngagementState(score) {
    if (score >= ENGAGEMENT_STATES.HIGH_MOMENTUM) return 'high_momentum';
    if (score >= ENGAGEMENT_STATES.STABLE)        return 'stable';
    if (score >= ENGAGEMENT_STATES.FRAGILE)       return 'fragile';
    return 'disengaging';
  },

  /**
   * detectBurnoutRisk(user)
   * Detects behavioral burnout patterns — not just one-off low completions.
   * Returns { isBurnout: bool, reason: string|null, severity: 'low'|'medium'|'high' }
   *
   * Signals:
   * - High consistency in first half of window + sharp drop in second half
   * - Many too_hard responses (> 30% of tasks)
   * - Sudden completion drop (was >= 70% now < 30%)
   *
   * @param {Object} user  - Full user row from DB
   * @returns {Object}
   */
  async detectBurnoutRisk(user) {
    try {
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - WINDOW_DAYS);
      const windowStartStr = windowStart.toISOString().split('T')[0];
      const today = new Date().toISOString().split('T')[0];

      const tasks = await taskQueries.getWeeklyTasks(user.id, windowStartStr, today);

      if (tasks.length < 3) {
        return { isBurnout: false, reason: null, severity: 'low' };
      }

      const m = this._computeMetrics(tasks, user);

      // Signal 1: high too_hard rate
      const highTooHard = m.tooHardRate >= 0.3;

      // Signal 2: trend collapse — was improving/stable, now dropping
      const trendCollapse = m.consistencyTrend === 'dropping' && m.completionRate < 0.4;

      // Signal 3: sudden drop (first half high, second half low)
      const sortedByDate = [...tasks].sort((a, b) =>
        new Date(a.assigned_date) - new Date(b.assigned_date)
      );
      const mid = Math.floor(sortedByDate.length / 2);
      const firstHalfTasks = sortedByDate.slice(0, mid);
      const secondHalfTasks = sortedByDate.slice(mid);

      const firstHalfRate = safeDivide(
        firstHalfTasks.filter(t => t.status === 'completed').length,
        firstHalfTasks.length
      );
      const secondHalfRate = safeDivide(
        secondHalfTasks.filter(t => t.status === 'completed').length,
        secondHalfTasks.length
      );
      const suddenDrop = firstHalfRate >= 0.7 && secondHalfRate < 0.3;

      let signals = 0;
      const reasons = [];

      if (highTooHard)   { signals++; reasons.push(`too_hard_rate=${(m.tooHardRate * 100).toFixed(0)}%`); }
      if (trendCollapse) { signals++; reasons.push('trend_collapse'); }
      if (suddenDrop)    { signals++; reasons.push(`sudden_drop: first_half=${(firstHalfRate*100).toFixed(0)}%→second_half=${(secondHalfRate*100).toFixed(0)}%`); }

      const severity = signals >= 3 ? 'high' : signals === 2 ? 'medium' : signals === 1 ? 'medium' : 'low';
      const isBurnout = signals >= 2;

      logger.info(
        `[BurnoutDetection] User ${user.telegram_id}: isBurnout=${isBurnout}, severity=${severity}, ` +
        `signals=[${reasons.join(', ')}]`
      );

      return {
        isBurnout,
        severity,
        reason: reasons.length > 0 ? reasons.join('; ') : null,
        signals: { highTooHard, trendCollapse, suddenDrop },
      };
    } catch (error) {
      logger.error(`[BurnoutDetection] Failed for user ${user.telegram_id}:`, error);
      return { isBurnout: false, reason: null, severity: 'low' };
    }
  },

  /**
   * detectRelapseRisk(user)
   * Detects early relapse patterns — user sliding back to inactivity.
   * Returns { isRelapse: bool, reason: string|null, severity: 'low'|'medium'|'high' }
   *
   * Signals:
   * - 2+ consecutive missed days (no completions)
   * - Inactivity spike (hours since last activity > MODERATE threshold)
   * - Sharp engagement score drop (requires prior score — uses streak as proxy)
   *
   * @param {Object} user  - Full user row from DB
   * @returns {Object}
   */
  async detectRelapseRisk(user) {
    try {
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - WINDOW_DAYS);
      const windowStartStr = windowStart.toISOString().split('T')[0];
      const today = new Date().toISOString().split('T')[0];

      const tasks = await taskQueries.getWeeklyTasks(user.id, windowStartStr, today);
      const m = this._computeMetrics(tasks, user);

      // Signal 1: consecutive missed days (days with tasks but zero completions)
      const consecutiveMissedDays = this._countConsecutiveMissedDays(tasks);
      const missedDaysSignal = consecutiveMissedDays >= 2;

      // Signal 2: inactivity spike
      const inactivitySignal = m.inactivityHours >= INACTIVITY_THRESHOLDS.MODERATE;

      // Signal 3: sharp engagement drop — streak reset after being active is the clearest proxy
      // If streak is 0 AND they had tasks in the window (meaning they were active and then stopped)
      const streakCollapseSignal = (user.current_streak === 0) && (tasks.length > 0) && (m.completionRate < 0.2);

      let signals = 0;
      const reasons = [];

      if (missedDaysSignal)     { signals++; reasons.push(`consecutive_missed_days=${consecutiveMissedDays}`); }
      if (inactivitySignal)     { signals++; reasons.push(`inactivity=${m.inactivityHours.toFixed(1)}h`); }
      if (streakCollapseSignal) { signals++; reasons.push('streak_collapse_with_low_completion'); }

      const severity = signals >= 3 ? 'high' : signals === 2 ? 'medium' : signals === 1 ? 'low' : 'low';
      const isRelapse = signals >= 2;

      logger.info(
        `[RelapseDetection] User ${user.telegram_id}: isRelapse=${isRelapse}, severity=${severity}, ` +
        `signals=[${reasons.join(', ')}]`
      );

      return {
        isRelapse,
        severity,
        reason: reasons.length > 0 ? reasons.join('; ') : null,
        signals: { missedDaysSignal, inactivitySignal, streakCollapseSignal, consecutiveMissedDays },
      };
    } catch (error) {
      logger.error(`[RelapseDetection] Failed for user ${user.telegram_id}:`, error);
      return { isRelapse: false, reason: null, severity: 'low' };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EXISTING PUBLIC API — PRESERVED
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Main entry point for existing callers (adaptationEngine, notificationEngine).
   * Returns full engagement snapshot including the new numeric score.
   */
  async analyze(user) {
    try {
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - WINDOW_DAYS);
      const windowStartStr = windowStart.toISOString().split('T')[0];
      const today = new Date().toISOString().split('T')[0];

      const recentTasks = await taskQueries.getWeeklyTasks(user.id, windowStartStr, today);
      const metrics = this._computeMetrics(recentTasks, user);
      const snapshot = this._buildSnapshot(metrics, user);

      // Attach new score fields to the existing snapshot — backwards compatible
      snapshot.engagementScore = await this.calculateEngagementScore(user);
      snapshot.engagementState = this.getEngagementState(snapshot.engagementScore);

      logger.info(
        `[EngagementAnalyzer] User ${user.telegram_id}: ` +
        `score=${snapshot.engagementScore}, state=${snapshot.engagementState}, ` +
        `level=${snapshot.engagementLevel}, burnout=${snapshot.burnoutRisk}, ` +
        `streak_risk=${snapshot.streakRisk}, inactivity=${snapshot.inactivityHours.toFixed(1)}h`
      );

      return snapshot;
    } catch (error) {
      logger.error(`[EngagementAnalyzer] Failed for user ${user.telegram_id}:`, error);
      return this._defaultSnapshot();
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  _computeMetrics(tasks, user) {
    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'completed');
    const skipped   = tasks.filter(t => t.status === 'skipped');
    const tooHard   = tasks.filter(t => t.status === 'too_hard');

    const completionRate = safeDivide(completed.length, total);
    const skipRate       = safeDivide(skipped.length, total);
    const tooHardRate    = safeDivide(tooHard.length, total);

    const timingScores = completed
      .filter(t => t.completed_at && t.due_date)
      .map(t => t.completed_at.split('T')[0] <= t.due_date ? 1 : 0);
    const onTimeRate = safeDivide(
      timingScores.filter(s => s === 1).length,
      timingScores.length
    );

    const lastCompleted = completed.length > 0
      ? completed.sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))[0].completed_at
      : null;
    const inactivityHours = lastCompleted
  ? hoursSince(lastCompleted)
  : hoursSince(user.last_active || null);

    const dayMap = {};
    tasks.forEach(t => {
      const d = t.assigned_date;
      if (!dayMap[d]) dayMap[d] = { completed: 0, total: 0 };
      dayMap[d].total++;
      if (t.status === 'completed') dayMap[d].completed++;
    });

    const dailyRates = Object.values(dayMap)
      .map(d => safeDivide(d.completed, d.total))
      .filter(r => !isNaN(r));

    const consistencyTrend = this._computeTrend(dailyRates);

    const currentStreak  = user.current_streak  || 0;
    const longestStreak  = user.longest_streak  || 0;
    const streakHealthRatio = safeDivide(currentStreak, Math.max(longestStreak, 1));

    const overwhelmScore = (tooHardRate * 0.6) + ((1 - completionRate) * 0.4);

    return {
      total, completionRate, skipRate, tooHardRate, onTimeRate,
      inactivityHours, consistencyTrend, dailyRates, streakHealthRatio,
      currentStreak, overwhelmScore,
      completedCount: completed.length,
      skippedCount:   skipped.length,
      tooHardCount:   tooHard.length,
    };
  },

  _computeTrend(rates) {
    if (rates.length < 3) return 'insufficient_data';
    const mid = Math.floor(rates.length / 2);
    const avgFirst  = rates.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const avgSecond = rates.slice(mid).reduce((a, b) => a + b, 0) / (rates.length - mid);
    const delta = avgSecond - avgFirst;
    if (delta > 0.1)  return 'improving';
    if (delta < -0.1) return 'dropping';
    return 'stable';
  },

  /**
   * Counts how many of the LAST N days had tasks assigned but zero completions.
   * Used for relapse detection only.
   */
  _countConsecutiveMissedDays(tasks) {
    if (tasks.length === 0) return 0;

    // Build a map: date → { hasTask, hasCompletion }
    const dayMap = {};
    tasks.forEach(t => {
      if (!dayMap[t.assigned_date]) dayMap[t.assigned_date] = { hasTask: false, hasCompletion: false };
      dayMap[t.assigned_date].hasTask = true;
      if (t.status === 'completed') dayMap[t.assigned_date].hasCompletion = true;
    });

    // Sort dates descending, count consecutive missed days from most recent
    const sortedDates = Object.keys(dayMap).sort((a, b) => new Date(b) - new Date(a));
    let consecutive = 0;
    for (const date of sortedDates) {
      if (dayMap[date].hasTask && !dayMap[date].hasCompletion) {
        consecutive++;
      } else {
        break; // streak broken
      }
    }
    return consecutive;
  },

  /**
   * Returns a 0–10 penalty for days in the window where tasks existed but nothing was done.
   * Scaled so 7 fully missed days = 10 point deduction.
   */
  _missedDaysPenalty(tasks) {
    const missedDays = this._countConsecutiveMissedDays(tasks);
    // max penalty: 10 points for 7+ missed days
    return clamp((missedDays / WINDOW_DAYS) * 10, 0, 10);
  },

  _buildSnapshot(m, user) {
    const engagementLevel = this._scoreEngagement(m);
    const burnoutRisk     = this._scoreBurnout(m);
    const streakRisk      = this._scoreStreakRisk(m, user);
    const motivationState = this._scoreMotivation(m);

    return {
      engagementLevel,
      streakRisk,
      burnoutRisk,
      motivationState,
      inactivityHours: m.inactivityHours,
      consistencyTrend: m.consistencyTrend,
      completionRate: m.completionRate,
      skipRate: m.skipRate,
      tooHardRate: m.tooHardRate,
      overwhelmScore: m.overwhelmScore,
      currentStreak: m.currentStreak,
      // engagementScore + engagementState are added by analyze() after this call
      _raw: {
        completedCount: m.completedCount,
        skippedCount:   m.skippedCount,
        tooHardCount:   m.tooHardCount,
        totalTasks:     m.total,
        onTimeRate:     m.onTimeRate,
        streakHealthRatio: m.streakHealthRatio,
      },
    };
  },

  _scoreEngagement(m) {
    if (m.inactivityHours >= INACTIVITY_THRESHOLDS.SEVERE) return 'disengaged';
    if (m.completionRate >= 0.7 && m.inactivityHours < INACTIVITY_THRESHOLDS.MILD) return 'high';
    if (m.completionRate >= 0.4 && m.inactivityHours < INACTIVITY_THRESHOLDS.MODERATE) return 'medium';
    return 'low';
  },

  _scoreBurnout(m) {
    let score = 0;
    if (m.tooHardRate > 0.3)           score += 2;
    if (m.tooHardRate > 0.5)           score += 1;
    if (m.overwhelmScore > 0.5)        score += 2;
    if (m.consistencyTrend === 'dropping') score += 1;
    if (m.skipRate > 0.4)              score += 1;
    if (score >= 5) return 'high';
    if (score >= 3) return 'medium';
    return 'low';
  },

  _scoreStreakRisk(m, user) {
    const streak = user.current_streak || 0;
    if (m.inactivityHours >= INACTIVITY_THRESHOLDS.SEVERE) return 'critical';
    if (m.inactivityHours >= INACTIVITY_THRESHOLDS.MODERATE && streak > 0) return 'high';
    if (m.completionRate < 0.3 && streak > 0) return 'medium';
    if (streak === 0) return 'medium';
    return 'low';
  },

  _scoreMotivation(m) {
    if (m.completionRate >= 0.7 && m.consistencyTrend !== 'dropping') return 'strong';
    if (m.completionRate >= 0.4 && m.inactivityHours < INACTIVITY_THRESHOLDS.MODERATE) return 'stable';
    if (m.inactivityHours >= INACTIVITY_THRESHOLDS.SEVERE || m.completionRate < 0.2) return 'collapsed';
    return 'declining';
  },

  _defaultSnapshot() {
    return {
      engagementLevel: 'medium',
      streakRisk: 'low',
      burnoutRisk: 'low',
      motivationState: 'stable',
      inactivityHours: 0,
      consistencyTrend: 'insufficient_data',
      completionRate: 0,
      skipRate: 0,
      tooHardRate: 0,
      overwhelmScore: 0,
      currentStreak: 0,
      engagementScore: 50,
      engagementState: 'fragile',
      _raw: {
        completedCount: 0,
        skippedCount: 0,
        tooHardCount: 0,
        totalTasks: 0,
        onTimeRate: 0,
        streakHealthRatio: 0,
      },
    };
  },

  INACTIVITY_THRESHOLDS,
  ENGAGEMENT_STATES,
};

module.exports = engagementAnalyzer;