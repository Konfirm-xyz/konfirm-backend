import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { pool } from '../db/pool';
import { WebhooksService } from './webhooks.service';

// Arbitrary but stable pg_advisory_lock key, namespaced away from the other
// sweepers (402_001..402_004). Same double-sweep-across-replicas guard as
// PaymentAttestationSweeperService; the per-row claim in
// WebhooksService.deliverDue is the second line of defence.
const WEBHOOK_LOCK_KEY = 402_005;

@Injectable()
export class WebhookDeliverySweeperService {
  private readonly logger = new Logger(WebhookDeliverySweeperService.name);

  constructor(private readonly webhooks: WebhooksService) {}

  @Cron('*/1 * * * *')
  async sweep(): Promise<void> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
        WEBHOOK_LOCK_KEY,
      ]);
      if (!rows[0].locked) return;
      try {
        await this.webhooks.deliverDue();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [WEBHOOK_LOCK_KEY]);
      }
    } catch (err) {
      this.logger.error(`webhook delivery sweep failed: ${err}`);
    } finally {
      client.release();
    }
  }
}
