import { Injectable, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';

// Persistent investigation thread attached to a payment — the missing piece
// between the one-shot status-change reason (admin_actions.detail) and a
// real working-notes workflow where an admin can leave context without
// necessarily changing the payment's status.
//
// Notes are append-only: there's no edit or delete because these are an
// audit record. If an admin needs to correct a note they can append a new
// one. The admin's name is joined on read so the UI can show attribution
// without a separate lookup.
@Injectable()
export class AdminPaymentNotesService {
  async create(paymentId: string, adminId: string, body: string) {
    // Verify the payment exists first so callers get a clean 404 rather than
    // a FK violation message that leaks schema details.
    const exists = await pool.query('SELECT id FROM payments WHERE id = $1', [paymentId]);
    if (exists.rows.length === 0) throw new NotFoundException('payment not found');

    const { rows } = await pool.query(
      `INSERT INTO payment_notes (payment_id, admin_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, payment_id, body, created_at`,
      [paymentId, adminId, body],
    );
    return rows[0];
  }

  async list(paymentId: string) {
    // Verify the payment exists so GET also returns 404 for unknown IDs
    // rather than an empty array that silently implies the payment exists.
    const exists = await pool.query('SELECT id FROM payments WHERE id = $1', [paymentId]);
    if (exists.rows.length === 0) throw new NotFoundException('payment not found');

    const { rows } = await pool.query(
      `SELECT pn.id, pn.payment_id, pn.body, pn.created_at,
              a.id AS admin_id, a.name AS admin_name
       FROM payment_notes pn
       LEFT JOIN admins a ON a.id = pn.admin_id
       WHERE pn.payment_id = $1
       ORDER BY pn.created_at ASC`,
      [paymentId],
    );
    return rows;
  }
}
