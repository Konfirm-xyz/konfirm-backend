-- Admin-account management (#249/#32): deactivation is a soft delete so the
-- admin_actions audit trail keeps a valid FK to the deactivated admin.
ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
