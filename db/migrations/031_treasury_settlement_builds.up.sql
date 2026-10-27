-- Short-lived holding pen between "backend builds an unsigned treasury tx"
-- and "backend submits what the signer signed in Freighter" -- same
-- pending + expires_at shape fee_settlements (migration 022) already uses
-- for the identical build -> client-signs -> submit pattern on the
-- merchant-fee side (see fees.service.ts).
--
-- propose_settlement/approve_settlement/execute_settlement all require
-- require_signer on a real treasury signer's own key, so the backend never
-- holds that key -- it only builds the unsigned XDR here, remembers the
-- tx hash it built, and later checks a submitted signed XDR hashes to the
-- exact same transaction before relaying it to the network. That check is
-- what stops a signer's wallet from being tricked into submitting a
-- different, tampered transaction under cover of "signed".
--
-- onchain_settlement_id is NULL for a 'propose' build, since
-- propose_settlement itself assigns the id -- only known once the signed
-- transaction actually confirms on-chain (its return value).
CREATE TABLE IF NOT EXISTS treasury_settlement_builds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('propose', 'approve', 'execute')),
    signer_address TEXT NOT NULL,
    onchain_settlement_id BIGINT,
    tx_hash TEXT NOT NULL,
    unsigned_xdr TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'failed')),
    submission_error TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    submitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_treasury_settlement_builds_pending ON treasury_settlement_builds (id)
    WHERE status = 'pending';
