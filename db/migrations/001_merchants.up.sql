CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
    risk_tier TEXT NOT NULL DEFAULT 'unverified'
        CHECK (risk_tier IN ('unverified','standard','established','enterprise')),
    fee_bps INT NOT NULL DEFAULT 10,
    stellar_base_address TEXT,
    next_link_seq BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The atomic sequence for muxed-ID allocation. This is the exact fix for the
-- original build's COUNT(*) collision bug — never derive an allocation from a
-- read, always from a single atomic UPDATE ... RETURNING.
CREATE OR REPLACE FUNCTION claim_link_seq(p_merchant_id UUID)
RETURNS BIGINT LANGUAGE sql AS $$
    UPDATE merchants SET next_link_seq = next_link_seq + 1
    WHERE id = p_merchant_id
    RETURNING next_link_seq - 1;
$$;
