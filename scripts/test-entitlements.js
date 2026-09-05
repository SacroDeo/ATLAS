// scripts/test-entitlements.js
// Unit test for BUG-005: a cold-cache Supabase error must NOT grant premium to
// everyone once payments are live. The fix makes the settings read tri-state
// ('on' | 'off' | 'unknown') so "the read failed" is distinguishable from
// "payments are deliberately off", and isPremium denies on 'unknown' once
// PAYMENTS_LAUNCHED=true.
//
// No network: config/supabase is replaced with a fake whose result is set per
// case. PAYMENTS_LAUNCHED is read at module load, so the module is re-required
// to exercise both the pre-launch and post-launch branches.

// A mutable single result the fake returns from .single(). Every case sets this
// then calls invalidateSettingsCache() so the 60s cache never hides the change.
let nextResult = { data: null, error: null };
const fakeSupabase = {
  from() { return fakeSupabase; },
  select() { return fakeSupabase; },
  eq() { return fakeSupabase; },
  single() { return Promise.resolve(nextResult); },
};

const supabasePath = require.resolve('../src/config/supabase');
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: { supabase: fakeSupabase },
};

const entitlementsPath = require.resolve('../src/services/premium/entitlements');
function loadEntitlements({ launched }) {
  delete require.cache[entitlementsPath];
  if (launched) process.env.PAYMENTS_LAUNCHED = 'true';
  else delete process.env.PAYMENTS_LAUNCHED;
  return require('../src/services/premium/entitlements');
}

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

const future = new Date(Date.now() + 30 * 86400000).toISOString();
const past = new Date(Date.now() - 86400000).toISOString();

// Set the flag read result, drop the cache, and evaluate on a fresh state.
async function withState(ent, state) {
  if (state === 'on') nextResult = { data: { value: true }, error: null };
  else if (state === 'off') nextResult = { data: { value: false }, error: null };
  else nextResult = { data: null, error: { message: 'cold cache / DB down' } }; // 'unknown'
  ent.invalidateSettingsCache();
}

(async () => {
  // ── 1. Payments OFF (beta): everyone is premium, no paywall ───────────────
  {
    const ent = loadEntitlements({ launched: false });
    await withState(ent, 'off');
    check('OFF: free user is premium (beta)', (await ent.isPremium({ tier: 'free' })) === true);
    check('OFF: null user is premium (beta)', (await ent.isPremium(null)) === true);
    check('OFF: paywall hidden', (await ent.paywallVisible({ tier: 'free' })) === false);
  }

  // ── 2. Payments ON: only genuine premium users qualify ────────────────────
  {
    const ent = loadEntitlements({ launched: true });
    await withState(ent, 'on');
    check('ON: null user → not premium', (await ent.isPremium(null)) === false);
    check('ON: founding → premium', (await ent.isPremium({ tier: 'founding' })) === true);
    check('ON: premium + future expiry → premium', (await ent.isPremium({ tier: 'premium', premium_until: future })) === true);
    check('ON: premium + past expiry → not premium', (await ent.isPremium({ tier: 'premium', premium_until: past })) === false);
    check('ON: premium + no expiry → premium', (await ent.isPremium({ tier: 'premium' })) === true);
    check('ON: free tier → not premium', (await ent.isPremium({ tier: 'free' })) === false);
    check('ON: paywall visible to free user', (await ent.paywallVisible({ tier: 'free' })) === true);
    check('ON: paywall hidden from founding user', (await ent.paywallVisible({ tier: 'founding' })) === false);
  }

  // ── 3. UNKNOWN pre-launch: stay beta-generous (nothing to protect) ────────
  {
    const ent = loadEntitlements({ launched: false });
    await withState(ent, 'unknown');
    check('UNKNOWN + not launched: free user still premium', (await ent.isPremium({ tier: 'free' })) === true);
    check('UNKNOWN + not launched: paywall hidden', (await ent.paywallVisible({ tier: 'free' })) === false);
  }

  // ── 4. THE regression — UNKNOWN post-launch must FAIL CLOSED ──────────────
  {
    const ent = loadEntitlements({ launched: true });
    await withState(ent, 'unknown');
    check('UNKNOWN + launched: free user is NOT gifted premium (BUG-005)', (await ent.isPremium({ tier: 'free' })) === false);
    check('UNKNOWN + launched: null user → not premium', (await ent.isPremium(null)) === false);
    // A genuine premium user must still be served even when the flag read fails.
    check('UNKNOWN + launched: founding user still premium', (await ent.isPremium({ tier: 'founding' })) === true);
    check('UNKNOWN + launched: paywall visible to free user', (await ent.paywallVisible({ tier: 'free' })) === true);
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log(`\ntest-entitlements: ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAIL  ${f}`);
    process.exit(1);
  }
  console.log('  all entitlements assertions passed');
  process.exit(0);
})();
