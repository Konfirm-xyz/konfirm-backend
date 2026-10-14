import { BadRequestException, Injectable } from '@nestjs/common';
import { pool } from '../db/pool';

// docs/RUNBOOK.md §4's most important rule, now enforced in code instead of
// left as tribal knowledge: "never manually set-cursor forward past
// unprocessed payments — that permanently skips real transactions."
function assertNotForward(current: string, target: string): void {
  if (target !== 'now' && !/^\d+$/.test(target)) {
    throw new BadRequestException("cursor must be a Horizon paging token (digits only) or the literal string 'now'");
  }
  if (current === 'now') return; // moving off 'now' to any real position is always backward
  if (target === 'now') {
    throw new BadRequestException("cannot set the cursor to 'now' from a real position — that skips every unprocessed payment since then");
  }
  if (BigInt(target) > BigInt(current)) {
    throw new BadRequestException('cursor can only move backward — this value is ahead of the current position');
  }
}

@Injectable()
export class AdminReconcilerService {
  async status() {
    const { rows } = await pool.query(`SELECT value, updated_at FROM reconciler_state WHERE key = 'cursor'`);
    return rows[0] ?? { value: null, updated_at: null };
  }

  async rewind(target: string) {
    const { rows } = await pool.query(`SELECT value FROM reconciler_state WHERE key = 'cursor'`);
    const current = rows[0]?.value ?? 'now';
    assertNotForward(current, target);

    const { rows: updated } = await pool.query(
      `UPDATE reconciler_state SET value = $1, updated_at = NOW() WHERE key = 'cursor' RETURNING value, updated_at`,
      [target],
    );
    return { previous: current, ...updated[0] };
  }

  async listSkippedOps(status?: string) {
    if (status) {
      const { rows } = await pool.query(
        `SELECT id, merchant_id, paging_token, tx_hash, raw_payload, error_message, failure_count, status, created_at
         FROM reconciler_skipped_ops
         WHERE status = $1
         ORDER BY created_at DESC`,
        [status],
      );
      return rows;
    }
    const { rows } = await pool.query(
      `SELECT id, merchant_id, paging_token, tx_hash, raw_payload, error_message, failure_count, status, created_at
       FROM reconciler_skipped_ops
       ORDER BY created_at DESC`,
    );
    return rows;
  }
}
