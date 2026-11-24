import { Injectable } from '@nestjs/common';
import { pool } from '../db/pool';

export interface AdminActivityFilter {
  admin_id?: string;
  action?: string;
  target_type?: string;
  target_id?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

// One generic audit log for every admin mutation, rather than a bespoke
// table per feature — "what did admins do and when" is always one query.
// Surfaced back to the admin UI as a recent-activity feed, not just written
// and forgotten.
@Injectable()
export class AdminActionsService {
  async log(adminId: string, action: string, targetType: string, targetId: string, detail?: Record<string, unknown>): Promise<void> {
    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminId, action, targetType, targetId, detail ? JSON.stringify(detail) : null],
    );
  }

  async recent(filterOrLimit: AdminActivityFilter | number = 20) {
    const opts: AdminActivityFilter = typeof filterOrLimit === 'number' ? { limit: filterOrLimit } : (filterOrLimit ?? {});
    const conditions: string[] = [];
    const values: (string | number)[] = [];

    if (opts.admin_id) {
      values.push(opts.admin_id);
      conditions.push(`aa.admin_id = $${values.length}`);
    }
    if (opts.action) {
      values.push(opts.action);
      conditions.push(`aa.action = $${values.length}`);
    }
    if (opts.target_type) {
      values.push(opts.target_type);
      conditions.push(`aa.target_type = $${values.length}`);
    }
    if (opts.target_id) {
      values.push(opts.target_id);
      conditions.push(`aa.target_id = $${values.length}`);
    }
    if (opts.from) {
      values.push(opts.from);
      conditions.push(`aa.created_at >= $${values.length}`);
    }
    if (opts.to) {
      values.push(opts.to);
      conditions.push(`aa.created_at <= $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    values.push(limit);
    const limitParam = `$${values.length}`;

    let offsetClause = '';
    if (opts.offset && opts.offset > 0) {
      values.push(opts.offset);
      offsetClause = ` OFFSET $${values.length}`;
    }

    const { rows } = await pool.query(
      `SELECT aa.id, aa.admin_id, aa.action, aa.target_type, aa.target_id, aa.detail, aa.created_at, a.name AS admin_name
       FROM admin_actions aa
       JOIN admins a ON a.id = aa.admin_id
       ${whereClause}
       ORDER BY aa.created_at DESC
       LIMIT ${limitParam}${offsetClause}`,
      values,
    );
    return rows;
  }
}
