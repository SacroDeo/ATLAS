// src/services/premium/entitlements.js
// Single source of truth for premium gating.
// RULE: every premium feature check goes through isPremium();
// every premium UI element renders only if paywallVisible() is true.
const { supabase } = require('../../config/supabase');

let settingsCache = { value: null, fetchedAt: 0 };
const CACHE_MS = 60 * 1000; // flags change rarely; 1-min cache saves a query per message

async function paymentsEnabled() {
  const now = Date.now();
  if (settingsCache.value !== null && now - settingsCache.fetchedAt < CACHE_MS) {
    return settingsCache.value;
  }
  const { data, error } = await supabase
    .from('app_settings').select('value').eq('key', 'payments_enabled').single();
  if (error) return settingsCache.value ?? false; // fail closed: no paywall on error
  settingsCache = { value: data.value === true, fetchedAt: now };
  return settingsCache.value;
}

function invalidateSettingsCache() { settingsCache = { value: null, fetchedAt: 0 }; }

// Does this user have premium features RIGHT NOW?
// While payments are OFF, everyone does (beta = full ATLAS free).
async function isPremium(user) {
  if (!(await paymentsEnabled())) return true;
  if (!user) return false;
  if (user.tier === 'founding') return true;
  if (user.tier === 'premium') {
    if (!user.premium_until) return true;
    return new Date(user.premium_until) > new Date();
  }
  return false;
}

// Should premium prompts/locks/upsells be shown to this user?
// OFF → never. ON → only to non-premium users.
async function paywallVisible(user) {
  if (!(await paymentsEnabled())) return false;
  return !(await isPremium(user));
}

module.exports = { paymentsEnabled, isPremium, paywallVisible, invalidateSettingsCache };
