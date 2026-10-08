import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FeesService } from './fees.service';

// Keeps fee settlements honest without anyone looking at them: confirms ones
// the merchant submitted by any route, and releases claims on ones that can
// never land. Failures are logged as errors, which Sentry picks up.
@Injectable()
export class FeesSweeperService {
  private readonly logger = new Logger(FeesSweeperService.name);

  constructor(private readonly fees: FeesService) {}

  @Cron('*/2 * * * *')
  async sweep() {
    try {
      return await this.fees.sweepPending();
    } catch (err) {
      this.logger.error(`fee settlement sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
