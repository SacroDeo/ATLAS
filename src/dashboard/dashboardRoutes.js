// src/dashboard/dashboardRoutes.js
// All dashboard API endpoints. Every data route is behind requireAuth and is
// scoped to req.telegramId — the id comes from the verified session cookie,
// never from client input, so one user can't read another's data.

const express = require('express');
const config = require('../config');
const logger = require('../utils/logger');

const userQueries = require('../database/queries/userQueries');
const taskQueries = require('../database/queries/taskQueries');
const timezoneUtils = require('../utils/timezoneUtils');

const {
  verifyTelegramLogin,
  issueSession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
} = require('./telegramAuth');
const googleAuth = require('./googleAuth');
const authQueries = require('../database/queries/authQueries');
const { rateLimit } = require('./rateLimit');

const router = express.Router();

// Auth endpoints do crypto + DB work per hit — keep them tight.
// Data endpoints get a looser burst allowance.
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, name: 'auth' });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, name: 'api' });
router.use('/auth', authLimiter);
router.use(apiLimiter);

// CSRF defense-in-depth for state-changing auth POSTs. The session and pending
// cookies are SameSite=Lax, so the browser already withholds them from cross-
// site POSTs — but a forced-logout POST clears the cookie WITHOUT reading it, so
// SameSite alone doesn't stop it, and a future switch to SameSite=None would drop
// the protection entirely. Reject any POST whose Origin/Referer host isn't our
// own. The dashboard's own logout/link fetches are same-origin (Origin === Host)
// and pass; a cross-site page's forged POST does not (BUG-019). Fails safe: a
// rejected logout just leaves the user signed in — it never exposes data.
function sameOriginOnly(req, res, next) {
  const host = req.get('host');
  const source = req.get('origin') || req.get('referer');
  // Browsers always send Origin (fetch/XHR) or at least Referer (form POST) on a
  // cross-site request. Absent both, it isn't a browser CSRF vector — don't
  // hard-fail non-browser clients (health checks, curl).
  if (source && host) {
    let sourceHost = null;
    try { sourceHost = new URL(source).host; } catch { /* unparseable → treat as mismatch */ }
    if (sourceHost !== host) {
      logger.warn(`CSRF: cross-origin ${req.method} ${req.originalUrl} from "${source}" (host "${host}") — rejected.`);
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
  }
  next();
}

// --- Auth ------------------------------------------------------------------

// Telegram Login Widget can deliver the payload two ways depending on config:
// as a redirect (GET query string) or via JS callback (POST body). Support both.
async function handleLogin(req, res) {
  const payload = req.method === 'GET' ? req.query : req.body;

  try {
    const user = verifyTelegramLogin(payload);

    // Only ensure the row EXISTS — don't bump last_active (a dashboard view
    // isn't goal activity; it was suppressing inactivity re-engagement) and
    // don't overwrite profile fields the bot owns.
    const existing = await userQueries.getUserByTelegramId(user.id);
    if (!existing) {
      await userQueries.createUser(user.id, {
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
      });
    }

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

router.post('/auth/logout', sameOriginOnly, (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// --- Google sign-in --------------------------------------------------------

// Start the OAuth flow: bounce the browser to Google's consent screen.
router.get('/auth/google', (req, res) => {
  if (!googleAuth.googleEnabled()) {
    return res.status(404).json({ error: 'Google sign-in not configured' });
  }
  res.redirect(googleAuth.buildAuthUrl());
});

// Google redirects back here with ?code & ?state.
router.get('/auth/google/callback', async (req, res) => {
  if (!googleAuth.googleEnabled()) {
    return res.status(404).json({ error: 'Google sign-in not configured' });
  }
  try {
    googleAuth.verifyState(req.query.state);
    if (!req.query.code) throw new Error('Missing authorization code');

    const { sub, email } = await googleAuth.exchangeCode(req.query.code);

    const existing = await authQueries.findIdentity('google', sub);
    if (existing && existing.telegram_id) {
      // Already linked to a Telegram account — straight in.
      const token = issueSession(existing.telegram_id);
      setSessionCookie(res, token);
      return res.redirect('/dashboard.html');
    }

    // First Google login (or linked never completed): remember the identity
    // and send them to the linking page.
    const identity = existing || (await authQueries.upsertIdentity('google', sub, email));
    googleAuth.setPendingCookie(res, identity.id);
    return res.redirect('/link.html');
  } catch (err) {
    logger.warn('Google login rejected:', err.message);
    return res.redirect('/dashboard.html?error=google');
  }
});

// link.html asks who is mid-linking, to show "Signed in as x@gmail.com".
router.get('/auth/pending', async (req, res) => {
  try {
    const identity = await googleAuth.getPendingIdentity(req);
    if (!identity) return res.status(401).json({ error: 'No pending sign-in' });
    res.json({ email: identity.email });
  } catch (err) {
    logger.error('/auth/pending failed:', err);
    res.status(500).json({ error: 'Failed to load pending sign-in' });
  }
});

// Complete the link: consume the code from /linkweb, attach telegram_id to
// the Google identity, and start a normal session.
router.post('/auth/link', sameOriginOnly, async (req, res) => {
  try {
    const identity = await googleAuth.getPendingIdentity(req);
    if (!identity) {
      return res.status(401).json({ error: 'Sign in with Google first' });
    }

    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return res.status(400).json({ error: 'Enter the 6-character code from the bot' });
    }

    const telegramId = await authQueries.consumeLinkCode(code);
    if (!telegramId) {
      return res.status(400).json({ error: 'Code invalid or expired — send /linkweb to the bot for a fresh one' });
    }

    await authQueries.linkIdentity(identity.id, telegramId);

    const token = issueSession(telegramId);
    setSessionCookie(res, token);
    googleAuth.clearPendingCookie(res);
    res.json({ ok: true });
  } catch (err) {
    logger.error('/auth/link failed:', err);
    res.status(500).json({ error: 'Linking failed' });
  }
});

// Dev login requires BOTH: not production AND an explicit opt-in flag.
// Gating on NODE_ENV alone was dangerous — NODE_ENV defaults to 'development'
// when unset, so a forgotten env var on a live server would have turned this
// endpoint into a full auth bypass (mint a session for any telegram id).
function devLoginEnabled() {
  return config.server.env !== 'production'
    && process.env.ENABLE_DEV_LOGIN === 'true';
}

// Public config the frontend needs to render the login widget.
router.get('/config', (req, res) => {
  res.json({
    botUsername: config.telegram.botUsername,
    devLogin: devLoginEnabled(),
    googleEnabled: googleAuth.googleEnabled(),
  });
});

// DEV-ONLY login. Lets you into the dashboard on localhost, where Telegram's
// Login Widget refuses to run. Requires ENABLE_DEV_LOGIN=true and never runs
// in production.
router.get('/dev-login', async (req, res) => {
  try {
    if (!devLoginEnabled()) {
      return res.status(404).json({ error: 'Not found' });
    }
    const telegramId = req.query.tid;
    if (!telegramId) {
      return res.status(400).json({ error: 'Pass ?tid=<your_telegram_id>' });
    }
    const token = issueSession(telegramId);
    setSessionCookie(res, token);
    res.redirect('/dashboard.html');
  } catch (err) {
    logger.error('/dev-login failed:', err);
    res.status(500).json({ error: 'Dev login failed' });
  }
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

function isoDaysAgo(days, timezone) {
  // Dates in the USER's timezone — the bot assigns tasks per-user-local-day,
  // so UTC dates here made "today/tomorrow" disagree with the bot near midnight.
  return timezoneUtils.getLocalDateStringDaysAgo(timezone || 'UTC', days);
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
    const start = isoDaysAgo(days, user.timezone);
    const end = timezoneUtils.getLocalDateString(user.timezone || 'UTC');

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
    const tz = user.timezone;
    const start = isoDaysAgo(days - 1, tz);
    const end = timezoneUtils.getLocalDateString(tz || 'UTC');

    const tasks = await taskQueries.getTasksInRange(user.id, start, end);

    // Bucket by assigned_date.
    const byDate = {};
    for (let i = 0; i < days; i++) {
      const d = isoDaysAgo(days - 1 - i, tz);
      byDate[d] = { date: d, completed: 0, total: 0 };
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

    const tasks = await taskQueries.getDailyTasks(
      user.id,
      timezoneUtils.getLocalDateString(user.timezone || 'UTC')
    );
    res.json({
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        difficulty: t.difficulty_level,
        estimatedTime: t.estimated_time,
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

    const tomorrow = isoDaysAgo(-1, user.timezone); // tomorrow in the USER's timezone
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
