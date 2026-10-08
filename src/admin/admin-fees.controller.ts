import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin-auth/admin-auth.guard';
import { pool } from '../db/pool';

// Who owes what. Read-only: settlement is the merchant's signature, and a
// merchant in arrears is handled through the existing suspend action.
@Controller('admin/fees')
@UseGuards(AdminGuard)
export class AdminFeesController {
  @Get('owed')
  async owed() {
    const { rows } = await pool.query(
      `SELECT m.id AS merchant_id, m.name, m.email, m.status,
              p.fee_asset_code AS asset_code, p.fee_asset_issuer AS asset_issuer,
              SUM(p.fee_owed_raw)::text AS amount, COUNT(*)::int AS payments,
              MIN(p.created_at) AS oldest_owed_at
       FROM payments p JOIN merchants m ON m.id = p.merchant_id
       WHERE p.fee_status = 'owed' AND p.status = 'paid'
       GROUP BY m.id, m.name, m.email, m.status, p.fee_asset_code, p.fee_asset_issuer
       ORDER BY oldest_owed_at ASC`,
    );
    return rows;
  }
}
