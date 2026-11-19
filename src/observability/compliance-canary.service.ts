import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { checkComplianceCanary, type ComplianceCanaryResult } from '../common/onchain-compliance';
import { captureException } from './sentry';

// backend#210's canary check used to run only when an admin opened the
// blockchain-status page, so a breach could sit unnoticed indefinitely.
// This runs it on its own schedule and escalates a breach to Sentry; the
// admin page keeps its own call as the human-readable view.
@Injectable()
export class ComplianceCanaryService {
  private readonly logger = new Logger(ComplianceCanaryService.name);

  @Cron('*/5 * * * *')
  async check(): Promise<ComplianceCanaryResult> {
    // Caught here like every other @Cron service: an uncaught rejection would
    // fall through to the cron library's bare console.error, skipping pino
    // and Sentry, on the one check meant to raise the alarm.
    try {
      const result = await checkComplianceCanary();
      if (result.ok === false) {
        this.logger.error(
          'compliance canary breach: canary address reads as allowed — compliance screening may not be running (see docs/KEYS.md)',
        );
        captureException(
          new Error('compliance canary breach: canary address reads as allowed — compliance screening may not be running'),
        );
      }
      return result;
    } catch (err) {
      this.logger.error(`compliance canary check failed: ${err instanceof Error ? err.message : String(err)}`);
      captureException(err);
      return { configured: false, ok: null };
    }
  }
}
