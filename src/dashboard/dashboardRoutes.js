// src/dashboard/dashboardRoutes.js
// All dashboard API endpoints. Every data route is behind requireAuth and is
// scoped to req.telegramId — the id comes from the verified session cookie,
// never from client input, so one user can't read another's data.

const express = require('express');
const config = require('../config');
const logger = require('../utils/logger');

const userQueries = require('../database/queries/userQueries');
const taskQueries = require('../database/queries/taskQueries');

const {
  verifyTelegramLogin,
  issueSession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
} = require('./telegramAuth');

const router = express.Router();

// --- Auth ------------------------------------------------------------------

// Telegram Login Widget can deliver the payload two ways depending on config:
// as a redirect (GET query string) or via JS callback (POST body). Support both.
async function handleLogin(req, res) {
  const payload = req.method === 'GET' ? req.query : req.body;

  try {
    const user = verifyTelegramLogin(payload);

    // Ensure the user exists in our DB (they normally will, from the bot).
    await userQueries.createUser(user.id, {
      username: user.username,
      first_name: user.first_name,
      last_name: user.last_name,
    });

    const token = issueSession(user.id);
    setSessionCookie(res, token);

    if (req.method === 'GET') {
      return res.redirect('/dashboard.html');
    }
    return res.json({ ok: true });
  } catch (err) {
    logger.warn('Dashboard login rejected:', err.message);
    if (req.method === 'GET') {
      return res.redirect('/dashboard.html?error=auth');
    }
    return res.status(401).json({ error: err.message });
  }
}

router.get('/auth/telegram', handleLogin);
router.post('/auth/telegram', handleLogin);

router.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Public config the frontend needs to render the login widget.
router.get('/config', (req, res) => {
  res.json({
    botUsername: config.telegram.botUsername,
    devLogin: config.server.env !== 'production',
  });
});

// DEV-ONLY login. Lets you into the dashboard on localhost, where Telegram's
// Login Widget refuses to run. Hard-disabled in production so it can never be
// used as an auth bypass on the live site.
router.get('/dev-login', async (req, res) => {
  if (config.server.env === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  const telegramId = req.query.tid;
  if (!telegramId) {
    return res.status(400).json({ error: 'Pass ?tid=<your_telegram_id>' });
  }
  const token = issueSession(telegramId);
  setSessionCookie(res, token);
  res.redirect('/dashboard.html');
});

// --- Helper: resolve internal user row from the session -------------------

async function loadUser(req, res) {
  const user = await userQueries.getUserByTelegramId(req.telegramId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  return user;
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

// --- Data endpoints (all authenticated) -----------------------------------

// Profile + headline stats for the top of the dashboard.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await loadUser(req, res);
    if (!user) return;

    res.json({
      firstName: user.first_name,
      username: user.username,
      goal: user.goal,
      currentStreak: user.current_streak || 0,
      longestStreak: user.longest_streak || 0,
      onboardingCompleted: user.onboarding_completed,
      memberSince: user.created_at,
    });
  } catch (err) {
    logger.error('/me failed:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// Aggregate completion stats over a window (default 30 days).
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const user = await loadUser(req, res);
    if (!user) return;

    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const start = isoDaysAgo(days);
    const end = new Date().toISOString().split('T')[0];

    const stats = await taskQueries.getCompletionStats(user.id, start, end);
    res.json({ windowDays: days, ...stats });
  } catch (err) {
    logger.error('/stats failed:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// Per-day completion series for the progress chart.
router.get('/progress', requireAuth, async (req, res) => {
  try {
    const user = await loadUser(req, res);
    if (!user) return;

    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);
    const start = isoDaysAgo(days - 1);
    const end = new Date().toISOString().split('T')[0];

    const tasks = await taskQueries.getTasksInRange(user.id, start, end);

    // Bucket by assigned_date.
    const byDate = {};
    for (let i = 0; i < days; i++) {
      byDate[isoDaysAgo(days - 1 - i)] = { date: isoDaysAgo(days - 1 - i), completed: 0, total: 0 };
    }
    for (const t of tasks) {
      const bucket = byDate[t.assigned_date];
      if (!bucket) continue;
      bucket.total += 1;
      if (t.status === 'completed') bucket.completed += 1;
    }

    res.json({ series: Object.values(byDate) });
  } catch (err) {
    logger.error('/progress failed:', err);
    res.status(500).json({ error: 'Failed to load progress' });
  }
});

// Today's task list.
router.get('/tasks/today', requireAuth, async (req, res) => {
  try {
    const user = await loadUser(req, res);
    if (!user) return;

    const tasks = await taskQueries.getDailyTasks(user.id);
    res.json({
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        difficulty: t.difficulty_level,
        estimatedTime: t.estimated_time,
        whyItMatters: t.why_it_matters,
      })),
    });
  } catch (err) {
    logger.error('/tasks/today failed:', err);
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});

// Tomorrow's task list. Tasks are generated each morning by the daily cron,
// so this is often empty late in the day — the frontend explains that.
router.get('/tasks/tomorrow', requireAuth, async (req, res) => {
  try {
    const user = await loadUser(req, res);
    if (!user) return;

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0];
    const tasks = await taskQueries.getDailyTasks(user.id, tomorrow);
    res.json({
      date: tomorrow,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        difficulty: t.difficulty_level,
        estimatedTime: t.estimated_time,
      })),
    });
  } catch (err) {
    logger.error('/tasks/tomorrow failed:', err);
    res.status(500).json({ error: 'Failed to load tomorrow\'s tasks' });
  }
});

// Roadmap coverage. The bot stores the roadmap as phases with a
// current_phase_index that advances as the user completes phase requirements,
// so phase progression is the honest measure of "% of roadmap covered".
router.get('/roadmap', requireAuth, async (req, res) => {
  try {
    const user = await loadUser(req, res);
    if (!user) return;

    let roadmap = user.roadmap_json;
    if (typeof roadmap === 'string') {
      try { roadmap = JSON.parse(roadmap); } catch { roadmap = null; }
    }
    if (!roadmap || !Array.isArray(roadmap.phases) || roadmap.phases.length === 0) {
      return res.json({ hasRoadmap: false });
    }

    const totalPhases = roadmap.phases.length;
    const currentIndex = Math.min(
      Math.max(roadmap.current_phase_index || 1, 1),
      totalPhases
    );
    const completedPhases = currentIndex - 1;
    const percentCovered = Math.round((completedPhases / totalPhases) * 100);

    res.json({
      hasRoadmap: true,
      goal: user.goal,
      totalPhases,
      currentPhaseIndex: currentIndex,
      percentCovered,
      phases: roadmap.phases.map((p) => ({
        index: p.phase_index,
        name: p.phase_name,
        difficulty: p.difficulty,
        requirements: p.completion_requirements || [],
        state: p.phase_index < currentIndex
          ? 'completed'
          : p.phase_index === currentIndex ? 'current' : 'upcoming',
      })),
    });
  } catch (err) {
    logger.error('/roadmap failed:', err);
    res.status(500).json({ error: 'Failed to load roadmap' });
  }
});

module.exports = router;
