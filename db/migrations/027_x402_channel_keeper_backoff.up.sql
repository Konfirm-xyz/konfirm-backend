-- Per-channel failure state for the channel keeper's checkpoint/finalize
-- attempts (src/x402/channel-keeper.service.ts). Without it every failing
-- channel was retried on every 2-minute sweep forever, all in lockstep.
-- Stored here rather than in memory because the sweep runs on whichever
-- api replica wins the advisory lock, so in-process counters would reset
-- every time a different replica picked it up.
ALTER TABLE x402_channels
    ADD COLUMN IF NOT EXISTS keeper_failure_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS keeper_last_error TEXT,
    ADD COLUMN IF NOT EXISTS keeper_last_error_kind TEXT
        CHECK (keeper_last_error_kind IN ('terminal', 'transient')),
    ADD COLUMN IF NOT EXISTS keeper_next_attempt_at TIMESTAMPTZ;
