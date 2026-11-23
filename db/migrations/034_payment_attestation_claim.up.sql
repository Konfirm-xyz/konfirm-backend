-- Attest-then-write-back idempotency (#67): the sweeper now claims a row
-- (attestation_claimed_at) before calling record_payment, so a DB failure
-- after a successful on-chain attestation can't make the next sweep submit a
-- second on-chain record for the same payment. A claim older than the
-- sweeper's stale window is treated as abandoned and retried.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS attestation_claimed_at TIMESTAMPTZ;

-- Same partial-index idiom as idx_payments_attestation_due (018): only the
-- small, shrinking attestation backlog is ever indexed.
CREATE INDEX IF NOT EXISTS idx_payments_attestation_claim
  ON payments (attestation_claimed_at)
  WHERE status = 'paid' AND attested_at IS NULL;
