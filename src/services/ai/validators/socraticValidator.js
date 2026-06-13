// src/services/ai/validators/socraticValidator.js

function validate(parsed) {
  if (!parsed) return { valid: false, error: 'Parsed result is null/undefined' };
  if (!parsed.understanding_level || typeof parsed.understanding_level !== 'string') {
    return { valid: false, error: 'Missing or invalid understanding_level' };
  }
  if (!parsed.evaluation || typeof parsed.evaluation !== 'string') {
    return { valid: false, error: 'Missing or invalid evaluation' };
  }
  return { valid: true, error: null };
}

module.exports = { validate };