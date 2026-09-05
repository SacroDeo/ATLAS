-- Migration 007 — users.premium_source: WHERE a user's premium came from
-- (was migrations/add_premium_source.sql)
--
-- WHY: beta-group members get 1 month of free Pro on join, revoked on leave.
-- But leaving must NOT strip premium from people who PAID or hold a lifetime
-- founding coupon. This column records the origin so the leave handler only
-- revokes what the group granted.
--
-- Values: 'group'    — granted by joining the beta Telegram group (revocable)
--         'paid'     — real UPI/card payment (never auto-revoked)
--         'coupon'   — redeemed a timed coupon
--         'founding' — lifetime founding tester (never auto-revoked)
--         NULL       — free tier / no premium

ALTER TABLE users
ADD COLUMN IF NOT EXISTS premium_source TEXT;

-- The two columns entitlements.isPremium() reads on every gated feature. They
-- were created by hand in the Supabase console and never written down, so a
-- fresh database had no premium concept at all.
ALTER TABLE users
ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'free';

ALTER TABLE users
ADD COLUMN IF NOT EXISTS premium_until TIMESTAMP WITH TIME ZONE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_tier_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_tier_check
      CHECK (tier IN ('free', 'premium', 'founding'));
  END IF;
END $$;
