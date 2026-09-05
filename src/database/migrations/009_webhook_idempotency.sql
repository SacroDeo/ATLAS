-- Migration 009 — webhook idempotency + payment reference validation
-- (was migrations/add_webhook_idempotency.sql)
--
-- Prevents replay attacks by recording processed webhook events. The Dodo
-- handler fails CLOSED if this table is unreadable, so it is not optional.

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

-- UPI reference length check on payments.
--
-- The original migration wrote `ALTER TABLE payments ADD CONSTRAINT IF NOT
-- EXISTS check_txn_ref_length ...`. That syntax does not exist in Postgres, so
-- the statement was a hard error every time it ran and the constraint was never
-- actually created. A catalog lookup is the idempotent form.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_txn_ref_length') THEN
    ALTER TABLE payments ADD CONSTRAINT check_txn_ref_length
      CHECK (length(txn_ref) >= 6 AND length(txn_ref) <= 50);
  END IF;
END $$;

COMMENT ON TABLE processed_webhook_events IS 'Tracks processed webhook events to prevent replay attacks';
COMMENT ON COLUMN processed_webhook_events.event_id IS 'Unique event ID from webhook provider (e.g., webhook-id header)';
COMMENT ON COLUMN processed_webhook_events.event_type IS 'Type of event (payment.succeeded, subscription.renewed, etc.)';
