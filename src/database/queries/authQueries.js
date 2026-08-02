// src/database/queries/authQueries.js
// Web-auth identities (Google, later Microsoft) and the one-time codes the
// bot hands out to link a web login to a Telegram account.
const { supabase } = require('../../config/supabase');

const authQueries = {
  async findIdentity(provider, providerUserId) {
    const { data, error } = await supabase
      .from('auth_identities')
      .select('*')
      .eq('provider', provider)
      .eq('provider_user_id', providerUserId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  async upsertIdentity(provider, providerUserId, email) {
    const { data, error } = await supabase
      .from('auth_identities')
      .upsert(
        { provider, provider_user_id: providerUserId, email },
        { onConflict: 'provider,provider_user_id' }
      )
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async linkIdentity(identityId, telegramId) {
    const { data, error } = await supabase
      .from('auth_identities')
      .update({ telegram_id: telegramId })
      .eq('id', identityId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async createLinkCode(code, telegramId, ttlMinutes = 10) {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
    const { error } = await supabase
      .from('web_link_codes')
      .upsert({ code, telegram_id: telegramId, expires_at: expiresAt });

    if (error) throw error;
    return { code, expiresAt };
  },

  /**
   * Look up a link code, delete it (single use), and return its telegram_id.
   * Returns null for unknown or expired codes.
   */
  // Atomic delete-returning: a concurrent request finds nothing to delete
  // and gets null — no TOCTOU window for double-use.
  async consumeLinkCode(code) {
    const { data, error } = await supabase
      .from('web_link_codes')
      .delete()
      .eq('code', code)
      .select()
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    return data.telegram_id;
  },
};

module.exports = authQueries;
