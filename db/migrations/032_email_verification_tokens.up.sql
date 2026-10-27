-- One-time email-verification tokens, issued at signup (#39). Same shape as
-- password_reset_tokens (021_account_recovery.up.sql): only a SHA-256 hash
-- of the token is stored, single-use, time-limited. A merchant is inserted
-- as 'pending' and stays that way until a valid token here is confirmed,
-- at which point AuthService.confirmEmail() flips status to 'active'.
--
-- This supersedes two earlier, conflicting attempts at this same table that
-- were added by editing already-applied migrations 001 and 021 directly
-- (one used `consumed_at`, the other `used_at`) — neither ever actually ran,
-- since the migration runner only applies a file once by name regardless of
-- later edits to its contents. This is the one real migration for it.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_verification_tokens_merchant_idx ON email_verification_tokens(merchant_id);
