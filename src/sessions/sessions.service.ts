import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';

@Injectable()
export class SessionsService {
  // Whether the payer's own session has landed. Deliberately narrow: this
  // says "received" and gives that payment's amount and tx hash. It does not
  // expose status or flags, and it never reveals any other payment.
  async statusFor(linkId: string, muxedId: string) {
    const { rows } = await pool.query(
      `SELECT p.amount_usdc, p.asset_code, p.tx_hash, p.created_at
       FROM link_sessions ls
       LEFT JOIN payments p ON p.merchant_id = ls.merchant_id AND p.muxed_id = ls.muxed_id
       WHERE ls.link_id = $1 AND ls.muxed_id = $2`,
      [linkId, muxedId],
    );
    if (rows.length === 0) throw new NotFoundException('session not found');
    const row = rows[0];
    if (!row.tx_hash) return { confirmed: false, payment: null };
    return {
      confirmed: true,
      payment: {
        amount_usdc: row.amount_usdc,
        asset_code: row.asset_code,
        tx_hash: row.tx_hash,
        created_at: row.created_at,
      },
    };
  }

  // This is the one server round trip §1 says is unavoidable — compliance
  // screening has to happen here in the real build. What it does today:
  // reserve the client-derived muxed_id against this Link, so the reconciler
  // can resolve link_id later without a second endpoint ever existing.
  async reserve(linkId: string, muxedId: string) {
    const link = await pool.query(
      `SELECT id, merchant_id, active FROM links WHERE id = $1`,
      [linkId],
    );
    if (link.rows.length === 0) throw new NotFoundException('link not found');
    if (!link.rows[0].active) throw new ConflictException('link is not active');

    const merchantId = link.rows[0].merchant_id;
    try {
      const { rows } = await pool.query(
        `INSERT INTO link_sessions (link_id, merchant_id, muxed_id)
         VALUES ($1, $2, $3)
         RETURNING id, link_id, merchant_id, muxed_id, created_at`,
        [linkId, merchantId, muxedId],
      );
      return rows[0];
    } catch (err: any) {
      // UNIQUE(merchant_id, muxed_id) — the collision this catches is the
      // one pressure-tested in the redesign memo: astronomically unlikely
      // at 64-bit random-nonce scale, but if it ever fires the correct
      // response is "pick a new nonce," never a silent overwrite of
      // someone else's reservation.
      if (err.code === '23505') {
        throw new ConflictException('muxed_id already reserved for this merchant — client should regenerate the nonce');
      }
      throw err;
    }
  }
}
