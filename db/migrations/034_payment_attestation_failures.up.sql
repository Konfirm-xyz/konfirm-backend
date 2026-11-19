-- Failure tracking for the attestation sweeper (#68). A payment whose
-- record_payment call keeps failing used to be re-picked first every sweep
-- (ORDER BY created_at ASC), so a backlog of permanently-failing rows could
-- starve newer payments out of every batch. The sweeper now records each
-- failure here and skips a row until attestation_next_attempt_at, backing
-- off exponentially up to a cap; rows past the dead-letter threshold are
-- left for a human (see the stuck-attestation admin notification).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS attestation_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS attestation_last_error TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS attestation_last_attempt_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS attestation_next_attempt_at TIMESTAMPTZ;

-- Same partial-index idiom as 018: only the shrinking attestation-due set.
-- Keyed on the next-attempt time so the sweep's "due now" filter is cheap.
DROP INDEX IF EXISTS idx_payments_attestation_due;
CREATE INDEX IF NOT EXISTS idx_payments_attestation_due
  ON payments (attestation_next_attempt_at, created_at)
  WHERE status = 'paid' AND attested_at IS NULL;
