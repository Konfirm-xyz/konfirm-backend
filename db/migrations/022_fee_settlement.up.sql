-- Fee settlement (docs/design/qr-fee-collection.md, Option B).
--
-- A payment's platform fee is either collected on-chain at checkout (the fee
-- leg was in the payer's transaction), or owed by the merchant (the payer
-- paid the link amount only, as QR and mobile wallets must). An owed fee is
-- cleared by one transaction the merchant signs, which pays the owed total
-- to the fee account from the merchant's own balance. Konfirm never holds
-- the merchant's key.
--
--   none      no fee expected (zero fee, or a pre-fee legacy row)
--   collected the fee leg was on-chain at checkout
--   owed      expected but not collected; the merchant owes it
--   claimed   included in a pending settlement the merchant hasn't signed yet
--   settled   cleared on-chain by a confirmed settlement
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS fee_status TEXT NOT NULL DEFAULT 'none'
    CHECK (fee_status IN ('none', 'collected', 'owed', 'claimed', 'settled')),
  ADD COLUMN IF NOT EXISTS fee_owed_raw NUMERIC(18, 7),
  ADD COLUMN IF NOT EXISTS fee_asset_code TEXT,
  ADD COLUMN IF NOT EXISTS fee_asset_issuer TEXT,
  ADD COLUMN IF NOT EXISTS fee_settlement_id UUID;

-- Rows already carrying an on-chain fee leg are collected. Nothing else is
-- retrofitted: a legacy row's owed fee is unknown, and guessing it would
-- invent a debt.
UPDATE payments SET fee_status = 'collected' WHERE fee_paging_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS fee_settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    tx_hash TEXT NOT NULL UNIQUE,
    unsigned_xdr TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'expired')),
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fee_settlements_merchant_idx ON fee_settlements(merchant_id, status);

ALTER TABLE payments
  ADD CONSTRAINT payments_fee_settlement_fk FOREIGN KEY (fee_settlement_id) REFERENCES fee_settlements(id);
