-- Normalize any existing mixed-case admin emails so the constraint below
-- does not fail on backfill.  Duplicate rows (same lowercased email, different
-- raw email) are extremely unlikely in practice, but the UPDATE is safe even
-- if that situation occurs: ON CONFLICT at the application level already
-- prevents new duplicates; this migration only corrects historical data.
UPDATE admins SET email = lower(trim(email));

-- Prevent non-lowercase emails from being inserted or updated.
-- Mirrors the CHECK already on merchants.email (021_account_recovery.up.sql).
ALTER TABLE admins ADD CONSTRAINT admins_email_lowercase CHECK (email = lower(email));
