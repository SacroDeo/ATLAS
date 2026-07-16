// src/utils/roadmapUtils.js
// Single source of truth for reading roadmap state off a user row.
// The phase index lives INSIDE roadmap_json (there is no users.current_phase_index
// column) — reading it from the wrong place froze task generation at phase 1.

/**
 * Parse a user's roadmap_json (handles string or object storage).
 * Returns null if absent or malformed.
 */
function getRoadmap(user) {
  let roadmap = user && user.roadmap_json;
  if (!roadmap) return null;
  if (typeof roadmap === 'string') {
    try { roadmap = JSON.parse(roadmap); } catch { return null; }
  }
  if (!Array.isArray(roadmap.phases) || roadmap.phases.length === 0) return null;
  return roadmap;
}

/**
 * The user's current phase index (1-based), clamped to the phase list.
 * Defaults to 1 when no roadmap exists.
 */
function getCurrentPhaseIndex(user) {
  const roadmap = getRoadmap(user);
  if (!roadmap) return 1;
  const idx = roadmap.current_phase_index || 1;
  return Math.min(Math.max(idx, 1), roadmap.phases.length);
}

/**
 * The user's current phase object, or null if they have no roadmap.
 */
function getCurrentPhase(user) {
  const roadmap = getRoadmap(user);
  if (!roadmap) return null;
  const idx = getCurrentPhaseIndex(user);
  return roadmap.phases.find((p) => p.phase_index === idx) || null;
}

module.exports = { getRoadmap, getCurrentPhaseIndex, getCurrentPhase };
