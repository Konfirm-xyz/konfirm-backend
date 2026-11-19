import { Injectable } from '@nestjs/common';
import { pool } from '../db/pool';

export interface AdminActionFilters {
  adminId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  /** Inclusive lower bound on created_at. */
  from?: string;
  /** Inclusive upper bound on created_at. */
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

  async recent(filters: AdminActionFilters = {}) {
    const { adminId, action, targetType, targetId, from, to, limit = 50, offset = 0 } = filters;
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (adminId) {
      params.push(adminId);
      conditions.push(`aa.admin_id = $${params.length}`);
    }
    if (action) {
      params.push(action);
      conditions.push(`aa.action = $${params.length}`);
    }
    if (targetType) {
      params.push(targetType);
      conditions.push(`aa.target_type = $${params.length}`);
    }
    if (targetId) {
      params.push(targetId);
      conditions.push(`aa.target_id = $${params.length}`);
    }
    if (from) {
      params.push(from);
      conditions.push(`aa.created_at >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`aa.created_at <= $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT aa.id, aa.admin_id, aa.action, aa.target_type, aa.target_id, aa.detail, aa.created_at, a.name AS admin_name
       FROM admin_actions aa
       JOIN admins a ON a.id = aa.admin_id
       ${where}
       ORDER BY aa.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows;
  }
}
