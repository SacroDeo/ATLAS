// src/services/ai/validators/weeklyReviewValidator.js

function validate(parsed) {
  if (!parsed) return { valid: false, error: 'Parsed result is null/undefined' };
  if (!parsed.review_text || typeof parsed.review_text !== 'string') {
    return { valid: false, error: 'Missing or invalid review_text' };
  }
  if (!Array.isArray(parsed.recommendations)) {
    return { valid: false, error: 'recommendations is not an array' };
  }
  return { valid: true, error: null };
}

module.exports = { validate };