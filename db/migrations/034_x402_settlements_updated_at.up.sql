-- recordAttempt() now corrects a stale 'failed'/'held' row in place when a
-- retried settlement for the same idempotency key later succeeds, so the row
-- needs a timestamp for when it was last corrected.
ALTER TABLE x402_settlements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
