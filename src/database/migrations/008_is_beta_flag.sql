-- Migration 008 — explicit beta-tester marker on users
-- (was migrations/add_is_beta_flag.sql)
--
-- WHY: "beta tester" was previously a proxy (onboarded + not founding), which
-- can't distinguish an INVITED tester from a random public signup. This flag is
-- the deliberate invite list — the basis for granting lifetime founding tier.
-- Tag testers with /makebeta <telegram_id>; untag with /unmakebeta <telegram_id>.

ALTER TABLE users
ADD COLUMN IF NOT EXISTS is_beta BOOLEAN DEFAULT false;

-- Fast filtering for the /beta roster.
CREATE INDEX IF NOT EXISTS idx_users_is_beta ON users(is_beta);
