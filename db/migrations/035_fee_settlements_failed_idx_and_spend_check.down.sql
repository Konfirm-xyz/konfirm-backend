ALTER TABLE facilitator_spend_log
  DROP CONSTRAINT IF EXISTS facilitator_spend_log_amount_nonnegative;

DROP INDEX IF EXISTS fee_settlements_submission_error_created_idx;
CREATE INDEX fee_settlements_failed_created_idx
  ON fee_settlements(created_at)
  WHERE status = 'failed';
