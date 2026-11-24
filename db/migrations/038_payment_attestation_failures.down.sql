-- Revert 038_payment_attestation_failures: restore 018's due index and drop
-- the sweeper's failure-tracking columns.
DROP INDEX IF EXISTS idx_payments_attestation_due;
CREATE INDEX IF NOT EXISTS idx_payments_attestation_due ON payments (created_at) WHERE status = 'paid' AND attested_at IS NULL;

ALTER TABLE payments DROP COLUMN IF EXISTS attestation_next_attempt_at;
ALTER TABLE payments DROP COLUMN IF EXISTS attestation_last_attempt_at;
ALTER TABLE payments DROP COLUMN IF EXISTS attestation_last_error;
ALTER TABLE payments DROP COLUMN IF EXISTS attestation_failure_count;
