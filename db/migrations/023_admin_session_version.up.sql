-- 023_admin_session_version.up.sql
--
-- Bumped on admin logout, so a token issued before logout stops passing
-- AdminGuard. Same role as merchants.session_version (migration 021).
ALTER TABLE admins ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
