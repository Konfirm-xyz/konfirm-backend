-- Wires the deployed-but-unused `payment` Soroban contract into checkout as
-- a pure attestation layer (see the contract's own doc comment: "an
-- attestation layer, not an escrow"). A payment with status='paid' and
-- attested_at IS NULL is picked up by PaymentAttestationSweeperService and
-- recorded on-chain via record_payment — additive, never blocks or delays
-- the classic payment that already fully settled to the merchant.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS onchain_payment_id BIGINT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS attested_at TIMESTAMPTZ;

-- Same "cheap index over the hot open set" idiom as x402_channels' partial
-- indexes — this table only ever has a small, shrinking backlog of
-- attestation-due rows at any moment, not a growing one.
CREATE INDEX idx_payments_attestation_due ON payments (created_at) WHERE status = 'paid' AND attested_at IS NULL;
