-- Email-change verification tokens (issue #38).
--
-- When a merchant requests an email address change, a short-lived, single-use
-- token is emailed to the *new* address.  Only a SHA-256 of the raw token is
-- stored here, matching the same pattern used by password_reset_tokens, so a
-- database read can never be turned into a working confirmation link.
--
-- The pending_email column carries the new address until the merchant clicks
-- the link.  If the merchant makes a second request before confirming the
-- first, the old pending row is replaced (via the merchant_id UNIQUE
-- constraint below), not stacked.
--
-- The used_at/expires_at lifecycle mirrors password_reset_tokens exactly.

CREATE TABLE IF NOT EXISTS email_change_tokens (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id  UUID        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    token_hash   TEXT        NOT NULL UNIQUE,
    pending_email TEXT       NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- One pending request per merchant at a time.  The service replaces the
    -- old row instead of inserting a second one.
    CONSTRAINT email_change_tokens_one_per_merchant UNIQUE (merchant_id)
);

CREATE INDEX IF NOT EXISTS email_change_tokens_merchant_idx
    ON email_change_tokens(merchant_id);
