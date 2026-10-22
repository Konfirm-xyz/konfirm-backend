import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';

@Injectable()
export class AdminMerchantsService {
  async list(limit = 50, offset = 0) {
    const { rows } = await pool.query(
      `SELECT id, email, name, status, risk_tier, fee_bps, stellar_base_address, created_at
       FROM merchants
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows;
  }

  // Returns the address a reset should go to, but only for an active
  // account: a suspended merchant can't use a reset link anyway, and sending
  // one would just be confusing mail.
  async emailForPasswordReset(id: string): Promise<string> {
    const { rows } = await pool.query('SELECT email, status FROM merchants WHERE id = $1', [id]);
    if (rows.length === 0) throw new NotFoundException('merchant not found');
    if (rows[0].status !== 'active') {
      throw new ConflictException('merchant is not active — reactivate the account before sending a reset');
    }
    return rows[0].email;
  }

  async setStatus(id: string, status: 'active' | 'suspended') {
    const { rows } = await pool.query(
      `UPDATE merchants SET status = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, status`,
      [id, status],
    );
    if (rows.length === 0) throw new NotFoundException('merchant not found');
    return rows[0];
  }

  // risk_tier already existed on this table and was already displayed
  // read-only on the merchants page — this is the missing write path, not
  // new schema. Genuine identity/KYC verification (documents, a provider
  // integration) is a separate, much bigger, and still entirely unbuilt
  // capability; this only lets an admin manually set which tier a merchant
  // is treated as, the same way status changes are manual today.
  async setTier(id: string, riskTier: 'unverified' | 'standard' | 'established' | 'enterprise') {
    // The FROM subquery reads the pre-update row (locked FOR UPDATE), so the
    // previous tier comes back from the same statement for the audit log.
    const { rows } = await pool.query(
      `UPDATE merchants m SET risk_tier = $2, updated_at = NOW()
       FROM (SELECT id, risk_tier FROM merchants WHERE id = $1 FOR UPDATE) old
       WHERE m.id = old.id
       RETURNING m.id, m.email, m.name, m.risk_tier, old.risk_tier AS previous_risk_tier`,
      [id, riskTier],
    );
    if (rows.length === 0) throw new NotFoundException('merchant not found');
    const { previous_risk_tier: previous, ...merchant } = rows[0];
    return { merchant, previous: previous as string };
  }

  // Admin-assisted profile override (issue #38).  Accepts any subset of
  // name / email / stellar_base_address.  Email changes bypass the
  // two-step verification flow that self-service uses — admins can apply
  // them directly as a support action.  When an email is changed here the
  // session_version is NOT bumped: the merchant's existing sessions remain
  // valid so a support action doesn't unexpectedly log them out mid-session.
  // The caller (AdminController) logs this to admin_actions.
  async updateProfile(
    id: string,
    fields: { name?: string; email?: string; stellar_base_address?: string },
  ) {
    const sets: string[] = [];
    const params: unknown[] = [id];

    if (fields.name !== undefined) {
      params.push(fields.name);
      sets.push(`name = $${params.length}`);
    }
    if (fields.email !== undefined) {
      // Reject if the new address is already taken by another merchant.
      const { rows: conflict } = await pool.query(
        'SELECT id FROM merchants WHERE email = $1 AND id <> $2',
        [fields.email, id],
      );
      if (conflict.length > 0) {
        throw new ConflictException('an account with this email already exists');
      }
      params.push(fields.email);
      sets.push(`email = $${params.length}`);
    }
    if (fields.stellar_base_address !== undefined) {
      params.push(fields.stellar_base_address);
      sets.push(`stellar_base_address = $${params.length}`);
    }

    if (sets.length === 0) {
      throw new BadRequestException('no fields to update');
    }

    sets.push('updated_at = NOW()');

    const { rows } = await pool.query(
      `UPDATE merchants SET ${sets.join(', ')}
       WHERE id = $1
       RETURNING id, email, name, stellar_base_address, status, risk_tier`,
      params,
    );
    if (rows.length === 0) throw new NotFoundException('merchant not found');
    return rows[0];
  }
}
