-- #331: support "find fee settlement(s) touching payment X" without seq scans.
CREATE INDEX IF NOT EXISTS fee_settlement_items_payment_idx
  ON fee_settlement_items (payment_id);

CREATE INDEX IF NOT EXISTS payments_fee_settlement_id_idx
  ON payments (fee_settlement_id)
  WHERE fee_settlement_id IS NOT NULL;
