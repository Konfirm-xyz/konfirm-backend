import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';
import { MAILER, Mailer, paymentConfirmedMail, paymentHeldMail } from '../mail/mailer';

@Injectable()
export class AdminPaymentsService {
  private readonly logger = new Logger(AdminPaymentsService.name);

  constructor(@Inject(MAILER) private readonly mailer: Mailer) {}

  async list(status?: string, limit = 50, offset = 0) {
    const params: unknown[] = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE p.status = $${params.length}`;
    }
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT p.id, p.amount_usdc, p.asset_code, p.payer_address, p.status, p.flag_reason, p.tx_hash, p.created_at,
              m.name AS merchant_name, m.email AS merchant_email
       FROM payments p
       JOIN merchants m ON m.id = p.merchant_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows;
  }

  async setStatus(id: string, status: 'paid' | 'held' | 'disputed' | 'voided') {
    // Same pre-update-snapshot pattern as AdminMerchantsService.setTier.
    const { rows } = await pool.query(
      `UPDATE payments p SET status = $2
       FROM (SELECT id, status FROM payments WHERE id = $1 FOR UPDATE) old
       WHERE p.id = old.id
       RETURNING p.id, p.status, old.status AS previous_status`,
      [id, status],
    );
    if (rows.length === 0) throw new NotFoundException('payment not found');
    const { previous_status: previous, ...payment } = rows[0];

    // Referral reward claw-back (issue #57): intended to revoke a
    // referrer's reward if the qualifying payment is later moved to a
    // non-qualifying status ('disputed'/'refunded'). This originally
    // targeted a `referral_rewards` table that does not exist anywhere in
    // this schema (a runtime 500 on every non-'paid' status change, not
    // caught by `npm run build` since it's a raw SQL string) — retargeted
    // to the real columns migration 025 added on `merchants`
    // (reward_qualifying_payment_id/reward_granted_at/reward_revoked_at).
    // Still effectively a no-op today: see referral-rewards.service.ts's
    // "Claw-back status" comment — nothing in this codebase ever sets
    // merchants.reward_qualifying_payment_id, so this WHERE clause has
    // nothing to match yet. Fixed here only enough to stop the 500;
    // actually wiring up the grant side is a product decision flagged
    // there, not guessed at here.
    if (status !== 'paid') {
      await pool.query(
        `UPDATE merchants m
         SET reward_granted_at = NULL, reward_revoked_at = now()
         WHERE m.reward_qualifying_payment_id = $1
           AND m.reward_granted_at IS NOT NULL
           AND m.reward_revoked_at IS NULL`,
        [id],
      );
    }

    // Merchant notification for the two statuses a merchant must hear about.
    // Best-effort, same shape as the referral-earned mail: a mail failure is
    // logged and swallowed so it can never roll back the committed status.
    if (status === 'paid' || status === 'held') {
      await this.notifyMerchant(id, status);
    }

    return { payment, previous: previous as string };
  }

  private async notifyMerchant(paymentId: string, status: 'paid' | 'held'): Promise<void> {
    try {
      const { rows } = await pool.query<{
        email: string | null;
        amount_usdc: string;
        asset_code: string;
        flag_reason: string | null;
      }>(
        `SELECT m.email, p.amount_usdc, p.asset_code, p.flag_reason
         FROM payments p
         JOIN merchants m ON m.id = p.merchant_id
         WHERE p.id = $1`,
        [paymentId],
      );
      const row = rows[0];
      if (!row?.email) return;
      const notification = {
        merchantEmail: row.email,
        amount: row.amount_usdc,
        currency: row.asset_code,
        reference: paymentId,
      };
      await this.mailer.send(
        status === 'paid'
          ? paymentConfirmedMail(notification)
          : paymentHeldMail({ ...notification, reason: row.flag_reason ?? undefined }),
      );
    } catch (err) {
      this.logger.error(`failed to send payment-${status} email for payment ${paymentId}: ${err}`);
    }
  }
}
