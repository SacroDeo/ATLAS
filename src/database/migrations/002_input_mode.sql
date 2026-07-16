-- Migration 002 — add users.input_mode
-- Run this in: Supabase Dashboard → SQL Editor → New query → paste → Run
--
-- Why: manual task-entry mode routes messages via users.input_mode
-- ('chat' | 'manual_task_entry'). The column was never added to the live
-- DB, so activating manual mode would fail on write.

ALTER TABLE users ADD COLUMN IF NOT EXISTS input_mode VARCHAR(30) DEFAULT 'chat';
