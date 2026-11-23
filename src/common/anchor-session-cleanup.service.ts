import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { pool } from '../db/pool';

// SEP-10 tokens expire in well under 24 h, so a row older than 24 h is never
// useful for dedup. This sweeper keeps anchor_interactive_sessions from
// growing unbounded — one row per start attempt, forever — fixing #348.
const TTL_HOURS = 24;

@Injectable()
export class AnchorSessionCleanupService {
  private readonly logger = new Logger(AnchorSessionCleanupService.name);

  @Cron('0 * * * *') // hourly
  async sweep(): Promise<void> {
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM anchor_interactive_sessions
         WHERE created_at < NOW() - ($1 * INTERVAL '1 hour')`,
        [TTL_HOURS],
      );
      if (rowCount) {
        this.logger.log(`pruned ${rowCount} expired anchor_interactive_sessions`);
      }
    } catch (err) {
      this.logger.error(
        `anchor session cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
