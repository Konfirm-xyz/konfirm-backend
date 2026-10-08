-- Why a payment is 'held' or carries a warning, so an admin reviewing it can
-- see the reason instead of guessing. NULL means no flag. Written by the
-- reconciler's payment verdict (reconciler/src/verdict.rs) at insert time,
-- and by the admin status endpoint when an admin changes a row by hand.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS flag_reason TEXT;
