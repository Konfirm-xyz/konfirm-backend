import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { pool } from '../db/pool';
import type { AdminRole } from '../admin-auth/admin-auth.service';

// Admin-account management (#249/#32): list, create and deactivate admin
// accounts without DB access. Deliberately separate from AdminAuthService,
// which only ever authenticates — this is the write surface, and every route
// that reaches it is scoped to `superadmin` in AdminController.
@Injectable()
export class AdminAdminsService {
  // Never selects password_hash — the hash must not leave the DB layer.
  async list(limit = 50, offset = 0) {
    const { rows } = await pool.query(
      `SELECT id, email, name, role, status, created_at, deactivated_at
       FROM admins
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows;
  }

  async create(email: string, password: string, name: string, role: AdminRole) {
    const account = email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(password, 10);
    try {
      const { rows } = await pool.query(
        `INSERT INTO admins (email, password_hash, name, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, name, role, status, created_at`,
        [account, passwordHash, name, role],
      );
      return rows[0];
    } catch (err) {
      // 23505 = unique_violation on admins.email.
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('an admin with that email already exists');
      }
      throw err;
    }
  }

  // Deactivation is a soft delete: the row stays so admin_actions history and
  // the audit trail keep a valid foreign key. Bumping session_version in the
  // same statement revokes any already-issued cookie at the next request
  // (AdminGuard re-checks it), so deactivation takes effect immediately.
  async deactivate(id: string, actingAdminId: string) {
    if (id === actingAdminId) {
      throw new BadRequestException('you cannot deactivate your own admin account');
    }
    const { rows } = await pool.query(
      `UPDATE admins
       SET status = 'deactivated', deactivated_at = NOW(), session_version = session_version + 1
       WHERE id = $1 AND status = 'active'
       RETURNING id, email, name, role, status, deactivated_at`,
      [id],
    );
    if (rows.length === 0) {
      const { rows: existing } = await pool.query('SELECT status FROM admins WHERE id = $1', [id]);
      if (existing.length === 0) throw new NotFoundException('admin not found');
      throw new ConflictException('admin is already deactivated');
    }
    return rows[0];
  }
}
