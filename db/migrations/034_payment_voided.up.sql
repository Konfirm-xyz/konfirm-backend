-- A payment voided on-chain (payment contract's void_payment) is no longer a
-- realized payment: it must stop counting as revenue and must be visibly
-- distinct from 'paid' in merchant/admin history. The reconciler's void sweep
-- (PaymentVoidSweeperService) is the only writer of this status.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('paid','held','refunded','disputed','voided'));

-- When the on-chain void was observed, so an admin can tell a voided row from
-- one that was merely flagged by hand.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
