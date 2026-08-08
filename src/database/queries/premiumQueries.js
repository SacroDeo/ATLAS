// src/database/queries/premiumQueries.js
const { supabase } = require('../../config/supabase');

// Canonical coupon form: no whitespace, uppercase. Applied on BOTH create and
// redeem so a code stored one way always matches a code typed another way.
function normalizeCode(code) {
  return String(code || '').replace(/\s+/g, '').toUpperCase();
}

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

  // Tag / untag an invited beta tester. Returns the updated row (null if no user
  // with that telegram_id exists) so the admin command can confirm or warn.
  async setBeta(telegramId, isBeta) {
    const { data, error } = await supabase
      .from('users')
      .update({ is_beta: isBeta })
      .eq('telegram_id', telegramId)
      .select('telegram_id, username, first_name, is_beta')
      .maybeSingle();
    if (error) throw error;
    return data; // null = no such user
  },

  // Grant beta + 1 month Pro to a group joiner. Sets is_beta, premium tier,
  // 30-day expiry, and stamps premium_source='group' so the leave handler knows
  // this premium is revocable. Does NOT downgrade a stronger source: if the user
  // is already 'founding' or 'paid', we tag beta but leave their premium alone.
  // Returns the updated row (null = no such user, i.e. never pressed /start).
  async grantGroupBeta(telegramId) {
    const existing = await supabase
      .from('users')
      .select('telegram_id, premium_source, tier')
      .eq('telegram_id', telegramId)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return null; // no row to update

    const strongerSources = ['founding', 'paid'];
    const keepPremium = strongerSources.includes(existing.data.premium_source);

    const update = { is_beta: true };
    if (!keepPremium) {
      update.tier = 'premium';
      update.premium_until = new Date(Date.now() + 30 * 864e5).toISOString();
      update.premium_source = 'group';
    }
    const { data, error } = await supabase
      .from('users')
      .update(update)
      .eq('telegram_id', telegramId)
      .select('telegram_id, username, first_name, is_beta, tier, premium_until, premium_source')
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  // Revoke on leaving the group: always untag is_beta; only strip premium when
  // it came FROM the group (premium_source='group'). Paid/founding users keep
  // everything. Two-step so the premium revoke is guarded by the source filter
  // and can never touch a paid/founding row.
  async revokeGroupBeta(telegramId) {
    const { error: betaErr } = await supabase
      .from('users')
      .update({ is_beta: false })
      .eq('telegram_id', telegramId);
    if (betaErr) throw betaErr;

    // Only this filter's rows (source='group') lose premium — atomic guard.
    const { data, error } = await supabase
      .from('users')
      .update({ tier: 'free', premium_until: null, premium_source: null })
      .eq('telegram_id', telegramId)
      .eq('premium_source', 'group')
      .select('telegram_id')
      .maybeSingle();
    if (error) throw error;
    return data; // non-null = group premium was revoked; null = nothing to revoke
  },

  // Atomic single-use redemption: the .is('redeemed_by', null) filter makes
  // a second redemption update 0 rows — no race, no double-spend.
  async redeemCoupon(code, telegramId) {
    const { data, error } = await supabase
      .from('coupons')
      .update({ redeemed_by: telegramId, redeemed_at: new Date().toISOString() })
      .eq('code', normalizeCode(code))
      .is('redeemed_by', null)
      .select()
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data; // null = invalid or already used
  },

  // For diagnosing a failed redeem: does the code exist, and is it spent?
  async getCoupon(code) {
    const { data, error } = await supabase
      .from('coupons')
      .select('*')
      .eq('code', normalizeCode(code))
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  async listCoupons() {
    const { data, error } = await supabase
      .from('coupons')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return data || [];
  },

  async createCoupon(code, grantsTier = 'founding', durationDays = null) {
    const { error } = await supabase.from('coupons').insert({
      code: normalizeCode(code), grants_tier: grantsTier, duration_days: durationDays,
    });
    if (error) throw error;
  },

  async logPayment(telegramId, amountInr, txnRef) {
    const { data, error } = await supabase.from('payments')
      .insert({ telegram_id: telegramId, amount_inr: amountInr, txn_ref: txnRef })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async verifyPayment(paymentId, approve, days = 30) {
    const { data, error } = await supabase
      .from('payments')
      .update({ status: approve ? 'verified' : 'rejected', verified_at: new Date().toISOString() })
      .eq('id', paymentId).eq('status', 'pending')
      .select().single();
    if (error && error.code !== 'PGRST116') throw error;
    if (approve && data) {
      const until = new Date(Date.now() + days * 864e5).toISOString();
      await this.setTier(data.telegram_id, 'premium', until);
    }
    return data;
  },
};

module.exports = premiumQueries;
