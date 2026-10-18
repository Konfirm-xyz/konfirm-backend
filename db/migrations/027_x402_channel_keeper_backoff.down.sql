ALTER TABLE x402_channels
    DROP COLUMN IF EXISTS keeper_next_attempt_at,
    DROP COLUMN IF EXISTS keeper_last_error_kind,
    DROP COLUMN IF EXISTS keeper_last_error,
    DROP COLUMN IF EXISTS keeper_failure_count;
