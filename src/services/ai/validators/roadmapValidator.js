// src/services/ai/validators/roadmapValidator.js

function validate(parsed) {
  if (!parsed) return { valid: false, error: 'Parsed result is null/undefined' };
  if (!parsed.roadmap_text || typeof parsed.roadmap_text !== 'string') {
    return { valid: false, error: 'Missing or invalid roadmap_text' };
  }
  if (!parsed.roadmap_json) {
    return { valid: false, error: 'Missing roadmap_json' };
  }
  if (!Array.isArray(parsed.roadmap_json.phases)) {
    return { valid: false, error: 'roadmap_json.phases is not an array' };
  }
  if (parsed.roadmap_json.phases.length === 0) {
    return { valid: false, error: 'roadmap_json.phases is empty' };
  }

  for (let i = 0; i < parsed.roadmap_json.phases.length; i++) {
    const phase = parsed.roadmap_json.phases[i];
    if (typeof phase.phase_index !== 'number') {
      return { valid: false, error: `Phase ${i} missing or invalid phase_index` };
    }
    if (!phase.phase_name || typeof phase.phase_name !== 'string') {
      return { valid: false, error: `Phase ${i} missing or invalid phase_name` };
    }
    if (!phase.difficulty || typeof phase.difficulty !== 'string') {
      return { valid: false, error: `Phase ${i} missing or invalid difficulty` };
    }
  }

  return { valid: true, error: null };
}

module.exports = { validate };