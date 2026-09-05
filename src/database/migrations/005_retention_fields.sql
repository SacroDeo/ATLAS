-- Migration 005 — retention nudge bookkeeping on users
-- (was migrations/add_retention_fields.sql; renumbered so migrations apply in
-- one deterministic order from a single directory)

-- Track whether user has received the day-2 recovery nudge
ALTER TABLE users
ADD COLUMN IF NOT EXISTS day2_recovery_sent_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Track whether user saw commitment screening message
ALTER TABLE users
ADD COLUMN IF NOT EXISTS commitment_screened_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
