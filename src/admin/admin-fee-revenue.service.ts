import { Injectable } from '@nestjs/common';
import { pool } from '../db/pool';

// Fee revenue was already captured on every payment row (payments.fee_usdc)
// — this is purely a missing aggregation/view, not new backend state. Only
// counts status = 'paid': a refunded or disputed payment's fee was never
// actually realized as revenue, so including it would overstate this
// number for exactly the transactions an admin is most likely to click
// into and check.
@Injectable()
export class AdminFeeRevenueService {
  async summary() {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS payment_count, COALESCE(SUM(fee_usdc), 0) AS total_fee_usdc
       FROM payments WHERE status = 'paid'`,
    );
    return { payment_count: Number(rows[0].payment_count), total_fee_usdc: rows[0].total_fee_usdc };
  }

  async daily(days = 30) {
    const { rows } = await pool.query(
      `SELECT DATE_TRUNC('day', created_at) AS day,
              COUNT(*) AS payment_count,
              COALESCE(SUM(fee_usdc), 0) AS fee_usdc
       FROM payments
       WHERE status = 'paid' AND created_at >= NOW() - ($1 * INTERVAL '24 hours')
       GROUP BY day
       ORDER BY day DESC`,
      [days],
    );
    return rows;
  }
}
