UPDATE payments SET status = 'refunded' WHERE status = 'voided';
ALTER TABLE payments DROP COLUMN IF EXISTS voided_at;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('paid','held','refunded','disputed'));
