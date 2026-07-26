-- Migration: Add webhook idempotency tracking
-- Prevents replay attacks by recording processed webhook events

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  telegram_id BIGINT,
  processed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_webhook_events_id ON processed_webhook_events(event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed ON processed_webhook_events(processed_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_user ON processed_webhook_events(telegram_id);

-- Add constraint to payments table for UPI reference validation
ALTER TABLE payments
ADD CONSTRAINT IF NOT EXISTS check_txn_ref_length
CHECK (length(txn_ref) >= 6 AND length(txn_ref) <= 50);

COMMENT ON TABLE processed_webhook_events IS 'Tracks processed webhook events to prevent replay attacks';
COMMENT ON COLUMN processed_webhook_events.event_id IS 'Unique event ID from webhook provider (e.g., webhook-id header)';
COMMENT ON COLUMN processed_webhook_events.event_type IS 'Type of event (payment.succeeded, subscription.renewed, etc.)';
