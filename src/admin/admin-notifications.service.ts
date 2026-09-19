import { Injectable } from '@nestjs/common';
import { pool } from '../db/pool';

export type NotificationSeverity = 'critical' | 'warning' | 'info';

export interface AdminNotification {
  id: string;
  type: 'x402_settlement' | 'payment' | 'withdrawal' | 'compliance' | 'attestation';
  severity: NotificationSeverity;
  message: string;
  created_at: string;
}

// No separate "notifications" table — every event here is derived live
// from a row that already exists for its own reason (a settlement, a
// disputed payment, a stuck withdrawal, a block decision). Sentry is a
// documented no-op in this deployment (SENTRY_DSN unset); this is the
// admin-visible substitute until that's wired up, built from data Konfirm
// already stores rather than a new event-logging pipeline.
@Injectable()
export class AdminNotificationsService {
  async list(limit = 50): Promise<AdminNotification[]> {
    const { rows } = await pool.query(
      `(
         SELECT id, 'x402_settlement' AS type,
                CASE status WHEN 'failed' THEN 'critical' ELSE 'warning' END AS severity,
                CASE status
                  WHEN 'failed' THEN 'x402 settlement failed for ' || LEFT(payer_address, 8) || '…'
                  ELSE 'x402 settlement held by compliance for ' || LEFT(payer_address, 8) || '…'
                END AS message,
                created_at
         FROM x402_settlements
         WHERE status IN ('failed', 'held')
       )
       UNION ALL
       (
         SELECT id, 'payment' AS type, 'warning' AS severity,
                'Payment disputed (' || amount_usdc || ' ' || asset_code || ')' AS message,
                created_at
         FROM payments
         WHERE status = 'disputed'
       )
       UNION ALL
       (
         SELECT id, 'withdrawal' AS type, 'critical' AS severity,
                'Withdrawal ' || last_status || ' (' || currency || ')' AS message,
                created_at
         FROM withdrawal_attempts
         WHERE last_status IN ('error', 'expired')
       )
       UNION ALL
       (
         SELECT id, 'compliance' AS type, 'info' AS severity,
                'Address blocked: ' || LEFT(stellar_address, 8) || '…'
                  || COALESCE(' (' || reason || ')', '') AS message,
                created_at
         FROM blocked_addresses
       )
       UNION ALL
       (
         -- Sweeps every 2 minutes (PaymentAttestationSweeperService); a row
         -- still unattested 10 minutes after the payment itself landed
         -- means at least several attempts have already failed, not just
         -- normal cron lag -- the exact silent-failure shape the September
         -- outage taught this project to surface rather than let sit
         -- unnoticed with Sentry unconfigured.
         SELECT id, 'attestation' AS type, 'warning' AS severity,
                'On-chain attestation still pending for payment ' || LEFT(id::text, 8) || '…' AS message,
                created_at
         FROM payments
         WHERE status = 'paid' AND attested_at IS NULL AND created_at < NOW() - INTERVAL '10 minutes'
       )
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows;
  }
}
