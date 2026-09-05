// src/services/premium/entitlements.js
// Single source of truth for premium gating.
// RULE: every premium feature check goes through isPremium();
// every premium UI element renders only if paywallVisible() is true.
const { supabase } = require('../../config/supabase');

let settingsCache = { value: null, fetchedAt: 0 };
const CACHE_MS = 60 * 1000; // flags change rarely; 1-min cache saves a query per message

// Once payments are live, set PAYMENTS_LAUNCHED=true. It flips the ONE unsafe
// default: when the settings read fails and we can't tell if payments are on,
// pre-launch we stay beta-generous (nothing to protect), post-launch we fail
// CLOSED so a transient DB error can't hand premium to everyone (BUG-005).
const PAYMENTS_LAUNCHED = process.env.PAYMENTS_LAUNCHED === 'true';

// Tri-state read of the payments flag: 'on' | 'off' | 'unknown'.
// 'unknown' = the settings read failed AND we have no fresh cached value. It is
// deliberately DISTINCT from 'off' (payments deliberately disabled) — collapsing
// the two is exactly what made a cold-cache error grant premium to everyone.
async function paymentsState() {
  const now = Date.now();
  if (settingsCache.value !== null && now - settingsCache.fetchedAt < CACHE_MS) {
    return settingsCache.value ? 'on' : 'off';
  }
  const { data, error } = await supabase
    .from('app_settings').select('value').eq('key', 'payments_enabled').single();
  if (error) {
    // Prefer a stale-but-real cached value over guessing; only report 'unknown'
    // when we have never successfully read the flag.
    if (settingsCache.value !== null) return settingsCache.value ? 'on' : 'off';
    return 'unknown';
  }
  settingsCache = { value: data.value === true, fetchedAt: now };
  return settingsCache.value ? 'on' : 'off';
}

// Public boolean form, kept for existing callers (admin /payments status, etc.).
// 'unknown' coerces to false here — identical to the old cold-cache behavior;
// the finer 'unknown' handling lives in isPremium/paywallVisible below.
async function paymentsEnabled() {
  return (await paymentsState()) === 'on';
}

function invalidateSettingsCache() { settingsCache = { value: null, fetchedAt: 0 }; }

// Does this user have premium features RIGHT NOW?
// While payments are OFF, everyone does (beta = full ATLAS free).
async function isPremium(user) {
  const state = await paymentsState();

  // Payments verifiably OFF → beta: everyone is premium.
  if (state === 'off') return true;

  // Settings read failed. Pre-launch there's no revenue to protect, so stay
  // beta-generous; post-launch fall through to the real per-user check so a DB
  // blip can never gift premium to everyone (BUG-005).
  if (state === 'unknown' && !PAYMENTS_LAUNCHED) return true;

  // state === 'on', or unknown-after-launch: grant only to genuine premium users.
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
  const state = await paymentsState();
  if (state === 'off') return false;                          // beta: no paywall
  if (state === 'unknown' && !PAYMENTS_LAUNCHED) return false; // pre-launch blip: no paywall
  return !(await isPremium(user));
}

module.exports = { paymentsEnabled, isPremium, paywallVisible, invalidateSettingsCache };
