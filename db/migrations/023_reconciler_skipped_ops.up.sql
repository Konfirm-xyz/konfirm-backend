-- Poison-pill / permanently malformed Horizon payment operations skipped by
-- watch-all after N consecutive failures at the same paging_token (issue #44).
--
-- Preserves the raw operation payload and error trace so an operator can
-- inspect and manually reprocess or dismiss the op without blocking all
-- subsequent payments for that merchant forever.
CREATE TABLE IF NOT EXISTS reconciler_skipped_ops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    paging_token TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    raw_payload TEXT,
    error_message TEXT NOT NULL,
    failure_count INT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_review'
      CHECK (status IN ('pending_review', 'reprocessed', 'ignored')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (merchant_id, paging_token)
);

CREATE INDEX IF NOT EXISTS reconciler_skipped_ops_merchant_status_idx
    ON reconciler_skipped_ops(merchant_id, status);
