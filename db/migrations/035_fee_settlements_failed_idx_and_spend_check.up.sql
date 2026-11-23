-- fee_settlements_failed_created_idx (024) filtered on status = 'failed',
-- a value the status CHECK forbids, so it could never index a row. The real
-- failure signal is submission_error IS NOT NULL (see FeesService.failSubmission).
DROP INDEX IF EXISTS fee_settlements_failed_created_idx;
CREATE INDEX fee_settlements_submission_error_created_idx
  ON fee_settlements(created_at)
  WHERE submission_error IS NOT NULL;

-- Schema-level backstop for FacilitatorSpendGuardService.checkAndRecordSpend's
-- own input validation. NOT VALID: enforced for new rows without scanning history.
ALTER TABLE facilitator_spend_log
  ADD CONSTRAINT facilitator_spend_log_amount_nonnegative
    CHECK (amount_usdc >= 0) NOT VALID;
