import { Injectable } from '@nestjs/common';
import { pool } from '../db/pool';

@Injectable()
export class AdminLinksService {
  async list(limit = 50, offset = 0) {
    const { rows } = await pool.query(
      `SELECT l.id, l.amount_usdc, l.currency, l.description, l.reusable, l.max_uses,
              l.expires_at, l.active, l.created_at,
              m.name AS merchant_name,
              COUNT(p.id) FILTER (WHERE p.status = 'paid')::int AS use_count,
              COALESCE(SUM(p.net_usdc) FILTER (WHERE p.status = 'paid'), 0) AS net_usdc
       FROM links l
       JOIN merchants m ON m.id = l.merchant_id
       LEFT JOIN payments p ON p.link_id = l.id AND p.status = 'paid'
       GROUP BY l.id, m.name
       ORDER BY l.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows;
  }
}
