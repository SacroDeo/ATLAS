# ATLAS Premium Package — Plan A (kill switch)
**Review & apply yourself. Nothing here is wired into src/ yet.**
Design: build everything → `payments_enabled = OFF` during beta (testers see ZERO premium UI, full ATLAS free) → flip ON at launch → founding testers redeem one-time coupons for lifetime Pro.

---

## 1. SQL — run in Supabase SQL editor

```sql
-- 1a. User tier
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free', 'premium', 'founding')),
  ADD COLUMN IF NOT EXISTS premium_until timestamptz; -- NULL for founding (never expires)

-- 1b. Global feature flags (the on/off switch)
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz DEFAULT now()
);
INSERT INTO app_settings (key, value)
  VALUES ('payments_enabled', 'false'::jsonb)
  ON CONFLICT (key) DO NOTHING;

-- 1c. One-time coupons (OTP-style: dies on first redemption)
CREATE TABLE IF NOT EXISTS coupons (
  code text PRIMARY KEY,
  grants_tier text NOT NULL DEFAULT 'founding' CHECK (grants_tier IN ('premium','founding')),
  duration_days int,                      -- NULL = lifetime
  created_at timestamptz DEFAULT now(),
  redeemed_by bigint,                     -- telegram_id; NULL = unused
  redeemed_at timestamptz
);

-- 1d. Payment log (manual UPI verification, day one)
CREATE TABLE IF NOT EXISTS payments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_id bigint NOT NULL,
  amount_inr int NOT NULL,
  txn_ref text,                           -- UPI reference user sends you
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  created_at timestamptz DEFAULT now(),
  verified_at timestamptz
);
```

## 2. `src/services/premium/entitlements.js` (new file)

```js
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
```

## 3. `src/database/queries/premiumQueries.js` (new file)

```js
const { supabase } = require('../../config/supabase');

const premiumQueries = {
  async setPaymentsEnabled(on) {
    const { error } = await supabase
      .from('app_settings')
      .update({ value: on, updated_at: new Date().toISOString() })
      .eq('key', 'payments_enabled');
    if (error) throw error;
  },

  async setTier(telegramId, tier, premiumUntil = null) {
    const { error } = await supabase
      .from('users')
      .update({ tier, premium_until: premiumUntil })
      .eq('telegram_id', telegramId);
    if (error) throw error;
  },

  // Atomic single-use redemption: the .is('redeemed_by', null) filter makes
  // a second redemption update 0 rows — no race, no double-spend.
  async redeemCoupon(code, telegramId) {
    const { data, error } = await supabase
      .from('coupons')
      .update({ redeemed_by: telegramId, redeemed_at: new Date().toISOString() })
      .eq('code', code.trim().toUpperCase())
      .is('redeemed_by', null)
      .select()
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data; // null = invalid or already used
  },

  async createCoupon(code, grantsTier = 'founding', durationDays = null) {
    const { error } = await supabase.from('coupons').insert({
      code: code.trim().toUpperCase(), grants_tier: grantsTier, duration_days: durationDays,
    });
    if (error) throw error;
  },

  async logPayment(telegramId, amountInr, txnRef) {
    const { error } = await supabase.from('payments')
      .insert({ telegram_id: telegramId, amount_inr: amountInr, txn_ref: txnRef });
    if (error) throw error;
  },

  async verifyPayment(paymentId, approve, days = 30) {
    const { data, error } = await supabase
      .from('payments')
      .update({ status: approve ? 'verified' : 'rejected', verified_at: new Date().toISOString() })
      .eq('id', paymentId).eq('status', 'pending')
      .select().single();
    if (error) throw error;
    if (approve && data) {
      const until = new Date(Date.now() + days * 864e5).toISOString();
      await this.setTier(data.telegram_id, 'premium', until);
    }
    return data;
  },
};

module.exports = premiumQueries;
```

## 4. Admin commands — add to your message handler's command section

```js
// Gate: only you. config.telegram.adminChatId should equal your ADMIN_CHAT_ID env.
function isAdmin(telegramId) {
  return String(telegramId) === String(process.env.ADMIN_CHAT_ID);
}

// /payments on | /payments off | /payments status
async function handlePaymentsToggle(msg, args) {
  if (!isAdmin(msg.from.id)) return; // silent for non-admins
  const premiumQueries = require('../database/queries/premiumQueries');
  const { paymentsEnabled, invalidateSettingsCache } = require('../services/premium/entitlements');

  const arg = (args || '').trim().toLowerCase();
  if (arg === 'on' || arg === 'off') {
    await premiumQueries.setPaymentsEnabled(arg === 'on');
    invalidateSettingsCache();
    return `💳 Payments are now *${arg.toUpperCase()}*`;
  }
  return `Payments: *${(await paymentsEnabled()) ? 'ON' : 'OFF'}*\nUse /payments on | off`;
}

// /makecoupon CODE [days]   → lifetime founding coupon if days omitted
async function handleMakeCoupon(msg, args) {
  if (!isAdmin(msg.from.id)) return;
  const premiumQueries = require('../database/queries/premiumQueries');
  const [code, days] = (args || '').trim().split(/\s+/);
  if (!code) return 'Usage: /makecoupon CODE [days]';
  await premiumQueries.createCoupon(code, 'founding', days ? parseInt(days, 10) : null);
  return `🎟️ Coupon *${code.toUpperCase()}* created (${days ? days + ' days' : 'lifetime'})`;
}

// /verifypay PAYMENT_ID ok|no
async function handleVerifyPay(msg, args) {
  if (!isAdmin(msg.from.id)) return;
  const premiumQueries = require('../database/queries/premiumQueries');
  const [id, verdict] = (args || '').trim().split(/\s+/);
  const row = await premiumQueries.verifyPayment(parseInt(id, 10), verdict === 'ok');
  return row ? `Payment ${id}: ${verdict === 'ok' ? '✅ verified, premium granted' : '❌ rejected'}`
             : `Payment ${id} not found or already handled`;
}
```

## 5. User command: /redeem CODE

```js
async function handleRedeem(msg, args) {
  const premiumQueries = require('../database/queries/premiumQueries');
  const code = (args || '').trim();
  if (!code) return 'Usage: /redeem YOURCODE';

  const coupon = await premiumQueries.redeemCoupon(code, msg.from.id);
  if (!coupon) return '❌ That code is invalid or has already been used.';

  const until = coupon.duration_days
    ? new Date(Date.now() + coupon.duration_days * 864e5).toISOString()
    : null;
  await premiumQueries.setTier(msg.from.id, coupon.grants_tier, until);

  return coupon.grants_tier === 'founding'
    ? '🏆 *Founding Tester unlocked!* Lifetime ATLAS Pro is yours. Thank you for building this with me.'
    : `⭐ *ATLAS Pro activated* ${coupon.duration_days ? `for ${coupon.duration_days} days` : ''}!`;
}
```

## 6. Paywall UI (only place premium is ever *shown*)

```js
// Show before any Pro-gated feature. QR image: put your UPI QR at assets/upi-qr.png.
const PRICE_INR = 49;

async function maybeSendPaywall(bot, chatId, user, featureName) {
  const { paywallVisible } = require('../services/premium/entitlements');
  if (!(await paywallVisible(user))) return false; // beta/premium: never show

  await bot.sendPhoto(chatId, 'assets/upi-qr.png', {
    caption:
      `⭐ *${featureName}* is an ATLAS Pro feature\n\n` +
      `₹${PRICE_INR}/month — unlimited goals, full memory, deep reviews\n\n` +
      `1. Pay ₹${PRICE_INR} to the UPI QR above\n` +
      `2. Send: /paid <UPI reference number>\n` +
      `3. I'll activate Pro within a few hours 🚀\n\n` +
      `Have a coupon? /redeem CODE`,
    parse_mode: 'Markdown',
  });
  return true; // caller should stop the gated action
}

// /paid TXN_REF — logs payment + alerts you in your admin DM
async function handlePaid(msg, args, bot) {
  const premiumQueries = require('../database/queries/premiumQueries');
  const ref = (args || '').trim();
  if (!ref) return 'Usage: /paid <UPI reference number>';
  await premiumQueries.logPayment(msg.from.id, PRICE_INR, ref);
  await bot.sendMessage(process.env.ADMIN_CHAT_ID,
    `💰 Payment claim\nUser: ${msg.from.id} (@${msg.from.username || '—'})\nRef: ${ref}\nVerify: /verifypay <id> ok`);
  return '🕐 Got it! Your payment is being verified — Pro activates within a few hours.';
}
```

## 7. Gating pattern (apply to each Pro feature when you build it)

```js
// Example: multi-goal (the crown jewel), inside the add-goal flow:
const { isPremium } = require('../services/premium/entitlements');
const goalCount = await goalQueries.countActiveGoals(user.telegram_id);
if (goalCount >= 1 && !(await isPremium(user))) {
  const shown = await maybeSendPaywall(bot, chatId, user, 'Multiple goals');
  if (shown) return; // stop here; free user keeps their 1 goal
}
```

## 8. Launch-day runbook
1. Beta ends → grant founders: `/makecoupon ATLASFOUNDER-<name>` per active tester → DM codes personally
2. They redeem → `founding` tier (survives payments ON)
3. `/payments on` → paywalls appear for everyone else
4. Watch `/paid` claims land in your DM → `/verifypay <id> ok`
5. Razorpay later: its webhook simply calls `verifyPayment()` — nothing else changes

## Answers locked in
- **Plan A (kill switch), not 14-day coupons** — testers never see paywalls during beta; no renewal clerking
- **Razorpay: yes** — Indian individual, PAN + Aadhaar + bank account; you RECEIVE money, no card needed
- **India:** UPI QR + manual verify (this package) → Razorpay automation when volume demands
- **International:** Telegram Stars when a foreign user actually asks — zero setup, global. Nothing else needed now.
