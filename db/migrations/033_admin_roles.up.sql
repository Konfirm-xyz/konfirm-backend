-- Admin roles (#32): AdminClaims/AdminGuard (src/admin-auth/) already read
-- and enforce admins.role, but the column was only ever added by editing
-- the already-applied 006_admins.up.sql directly — which never actually
-- ran, since the migration runner applies each file once by name regardless
-- of later edits to its contents. This is the real migration for it.
ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'superadmin' CHECK (role IN ('superadmin', 'support'));
