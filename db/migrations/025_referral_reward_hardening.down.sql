DROP INDEX IF EXISTS idx_merchants_reward_reversal;
ALTER TABLE merchants DROP COLUMN IF EXISTS reward_granted_at;
ALTER TABLE merchants DROP COLUMN IF EXISTS reward_revoked_at;
ALTER TABLE merchants DROP COLUMN IF EXISTS reward_qualifying_payment_id;
ALTER TABLE merchants DROP COLUMN IF EXISTS referrer_reward_count;
