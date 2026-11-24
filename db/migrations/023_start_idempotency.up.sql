-- 023_start_idempotency.up.sql
--
-- Inbound idempotency for POST /withdrawals/start and /deposits/start.
-- AnchorClient.startInteractive is deliberately never retried by Konfirm's
-- own HTTP client, but a client-side retry (timeout, double-tap, two tabs)
-- still reaches the controller as a second, independent request. Each row
-- remembers the anchor session minted for one (direction, account, currency,
-- SEP-10 token) key, so a repeat returns that session instead of minting a
-- second one. The SEP-10 token's own short lifetime bounds the dedup window.
CREATE TABLE IF NOT EXISTS anchor_interactive_sessions (
    idempotency_key TEXT PRIMARY KEY,
    direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdraw')),
    session JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One tracking row per anchor transaction, so a duplicate insert can't
-- record the same attempt twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawal_attempts_anchor_tx ON withdrawal_attempts (anchor_tx_id);

-- DB-enforced backstop for BazaarService.submit's same-URL check: at most
-- one pending listing per URL, even if two submissions race.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bazaar_listings_pending_url ON bazaar_listings (url) WHERE status = 'pending';
