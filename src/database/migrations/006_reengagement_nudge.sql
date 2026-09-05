-- Migration 006 — re-engagement nudge timestamp on users
-- (was migrations/add_reengagement_nudge.sql)
--
-- Timestamp of the last sympathetic "did you forget your goal?" nudge we sent.
-- Set when a nudge is delivered; cleared (back to NULL) whenever the user
-- completes a task, so a fresh inactivity spell can be nudged again.
ALTER TABLE users
ADD COLUMN IF NOT EXISTS reengagement_nudge_sent_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
