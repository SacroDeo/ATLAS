-- Add premium_source to users: WHERE a user's premium came from.
-- Run this migration on your Supabase database.
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
