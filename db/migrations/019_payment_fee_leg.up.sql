-- Records which specific Horizon operation funded the observed platform
-- fee (the second leg of checkout's now-real fee split), for the same
-- auditability reason fx_rate_to_usd was added in migration 013. NULL
-- distinguishes "no fee expected" / "fee expected but not observed" (the
-- payer bypassed the intended checkout flow) from a legitimately-populated
-- fee_usdc.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS fee_paging_token TEXT;
