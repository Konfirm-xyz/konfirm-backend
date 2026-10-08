DROP TABLE IF EXISTS password_reset_tokens;
ALTER TABLE merchants DROP COLUMN IF EXISTS session_version;
ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_email_lowercase;
