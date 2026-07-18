-- Migration 003 — web auth identities + Telegram link codes
-- Run this in: Supabase Dashboard → SQL Editor → New query → paste → Run
--
-- Why: "Sign in with Google" gives us a Google account id (sub) + email,
-- but all ATLAS data is keyed by telegram_id. auth_identities remembers
-- which Google account maps to which Telegram account (linked once via a
-- short-lived code the bot hands out — web_link_codes).

CREATE TABLE IF NOT EXISTS auth_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(20) NOT NULL,              -- 'google' (later: 'microsoft')
    provider_user_id VARCHAR(255) NOT NULL,     -- Google's stable "sub" claim
    email VARCHAR(255),
    telegram_id BIGINT,                         -- null until linked
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_telegram
    ON auth_identities (telegram_id);

CREATE TABLE IF NOT EXISTS web_link_codes (
    code VARCHAR(12) PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
