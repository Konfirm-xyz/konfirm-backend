-- Merchant API keys (#247): programmatic access for merchants, an alternative
-- to the session cookie on selected merchant-scoped routes.
--
-- Only a SHA-256 hash of the key is stored — the raw key is shown once at
-- creation and never again, same pattern as password_reset_tokens and
-- email_verification_tokens. Revocation is a soft delete (revoked_at) so an
-- audit trail of issued keys survives.
CREATE TABLE IF NOT EXISTS merchant_api_keys (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id  UUID        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    -- First few characters of the key, for display in the UI ("konfirm_live_ab12…").
    key_prefix   TEXT        NOT NULL,
    key_hash     TEXT        NOT NULL UNIQUE,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS merchant_api_keys_merchant_idx ON merchant_api_keys(merchant_id);
