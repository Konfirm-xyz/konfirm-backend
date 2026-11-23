-- Postgres doesn't auto-index FK columns; these six had no covering index (#334).
CREATE INDEX IF NOT EXISTS admin_actions_admin_id_idx ON admin_actions (admin_id);
CREATE INDEX IF NOT EXISTS link_sessions_link_id_idx ON link_sessions (link_id);
CREATE INDEX IF NOT EXISTS bazaar_listings_reviewed_by_idx ON bazaar_listings (reviewed_by);
CREATE INDEX IF NOT EXISTS blocked_addresses_blocked_by_idx ON blocked_addresses (blocked_by);
CREATE INDEX IF NOT EXISTS merchant_members_invited_by_idx ON merchant_members (invited_by);
CREATE INDEX IF NOT EXISTS member_invites_invited_by_idx ON member_invites (invited_by);
