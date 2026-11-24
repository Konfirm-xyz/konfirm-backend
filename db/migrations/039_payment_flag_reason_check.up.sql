-- Add a CHECK constraint to payments.flag_reason so the database enforces the
-- known value set written by the reconciler (reconciler/src/verdict.rs) and
-- by admin tooling. Without this, a typo'd or novel value silently persists
-- and is invisible in queries that filter on specific flag reasons.
--
-- Existing rows must already contain only valid values or NULL; the constraint
-- is validated in a single scan at migration time (safe for tables of normal
-- production size).
ALTER TABLE payments
  ADD CONSTRAINT payments_flag_reason_check
  CHECK (flag_reason IS NULL OR flag_reason IN (
    'no_session',
    'link_inactive',
    'no_fixed_amount',
    'asset_mismatch',
    'issuer_mismatch',
    'amount_mismatch',
    'blocked_address',
    'duplicate_session'
  ));
