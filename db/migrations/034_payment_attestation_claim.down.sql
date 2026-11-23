DROP INDEX IF EXISTS idx_payments_attestation_claim;
ALTER TABLE payments DROP COLUMN IF EXISTS attestation_claimed_at;
