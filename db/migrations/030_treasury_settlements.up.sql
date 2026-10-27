-- Mirrors on-chain treasury Settlement structs (konfirm-contracts
-- contracts/treasury's propose_settlement/approve_settlement/
-- execute_settlement), the same way x402_channels mirrors on-chain
-- Channel structs. The contract has no "list all settlements" primitive
-- (only get_settlement(id)), so this table is how the admin UI knows which
-- settlement ids exist at all -- populated by AdminTreasurySettlementsService
-- .registerOrResync(), which always re-reads the real on-chain record
-- before writing, never trusts the caller's claim of what it says. Every
-- propose/approve/execute happens from a connected signer's wallet
-- directly against the chain (see docs/PRD.md M2 -- require_signer means
-- the backend never holds these keys); this table is a read cache, not a
-- source of truth.
CREATE TABLE IF NOT EXISTS treasury_settlements (
    onchain_settlement_id BIGINT PRIMARY KEY,
    merchant_address TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    approvals_count INT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('Pending', 'Executed', 'Cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_treasury_settlements_pending ON treasury_settlements (onchain_settlement_id)
    WHERE status = 'Pending';
