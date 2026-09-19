DROP INDEX IF EXISTS idx_payments_attestation_due;
ALTER TABLE payments DROP COLUMN IF EXISTS attested_at;
ALTER TABLE payments DROP COLUMN IF EXISTS onchain_payment_id;
