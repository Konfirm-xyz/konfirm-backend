ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_fee_settlement_fk;
DROP TABLE IF EXISTS fee_settlements;
ALTER TABLE payments
  DROP COLUMN IF EXISTS fee_settlement_id,
  DROP COLUMN IF EXISTS fee_asset_issuer,
  DROP COLUMN IF EXISTS fee_asset_code,
  DROP COLUMN IF EXISTS fee_owed_raw,
  DROP COLUMN IF EXISTS fee_status;
