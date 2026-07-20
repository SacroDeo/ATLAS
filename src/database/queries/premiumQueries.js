// src/database/queries/premiumQueries.js
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
