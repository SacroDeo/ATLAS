-- Migration 001 — allow midday/evening check-in types
-- Run this in: Supabase Dashboard → SQL Editor → New query → paste → Run
--
-- Why: the checkins table has a CHECK constraint that only allows
-- ('daily','socratic','stuck'). The check-in notification system writes
-- 'checkin_midday' and 'checkin_evening' rows for dedup, which the old
-- constraint rejects (error 23514) — silently blocking those notifications.

ALTER TABLE checkins DROP CONSTRAINT IF EXISTS checkins_checkin_type_check;

ALTER TABLE checkins ADD CONSTRAINT checkins_checkin_type_check
  CHECK (checkin_type IN ('daily', 'socratic', 'stuck', 'checkin_midday', 'checkin_evening'));

-- The dedup upsert also needs a unique constraint on (user_id, date, checkin_type).
-- Add it if it doesn't exist yet (harmless if it already does).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checkins_user_date_type_unique'
  ) THEN
    ALTER TABLE checkins ADD CONSTRAINT checkins_user_date_type_unique
      UNIQUE (user_id, date, checkin_type);
  END IF;
END $$;
