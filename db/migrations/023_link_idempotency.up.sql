-- 023_link_idempotency.up.sql
--
-- Idempotent link creation. A client that times out on POST /links can retry
-- with the same idempotency_key and get the original row back, instead of a
-- second, independently payable link.
--
-- Scoped per merchant so two merchants can use the same key without colliding.
-- Nullable on purpose: a link created without a key is never deduplicated, and
-- Postgres treats NULLs as distinct in a unique index, so those rows don't
-- conflict with each other.
ALTER TABLE links
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS links_merchant_idempotency_key_idx
  ON links(merchant_id, idempotency_key);
