import { Injectable } from '@nestjs/common';
import { pool } from '../db/pool';

@Injectable()
export class AdminLinksService {
  async list(active?: boolean, limit = 50, offset = 0) {
    const params: unknown[] = [];
    let where = '';
    if (active !== undefined) {
      params.push(active);
      where = `WHERE l.active = $${params.length}`;
    }
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT l.id, l.amount_usdc, l.currency, l.description, l.reusable, l.max_uses,
              l.expires_at, l.active, l.created_at,
              m.name AS merchant_name,
              COUNT(p.id)::int AS use_count,
              COALESCE(SUM(p.net_usdc), 0) AS net_usdc
       FROM links l
       JOIN merchants m ON m.id = l.merchant_id
       LEFT JOIN payments p ON p.link_id = l.id
       ${where}
       GROUP BY l.id, m.name
       ORDER BY l.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows;
  }
}
