import { Injectable } from '@nestjs/common';
import { pool } from '../db/pool';

export interface OwedFeesRow {
  merchant_id: string;
  merchant_name: string;
  merchant_email: string;
  merchant_status: string;
  fee_asset_code: string;
  fee_asset_issuer: string;
  total_owed: string;
  oldest_owed_at: string;
  has_disputed_settlement: boolean;
  disputed_settlement_count: number;
}

export interface DisputedSettlementTotal {
  asset_code: string;
  asset_issuer: string;
  amount: string;
}

export interface DisputedSettlementRow {
  settlement_id: string;
  merchant_id: string;
  name: string;
  email: string;
  tx_hash: string | null;
  created_at: string;
  unsigned_xdr: string;
  totals: DisputedSettlementTotal[];
}

export interface OwedFeesQuery {
  limit?: number;
  offset?: number;
}

export interface OwedFeesResult {
  data: OwedFeesRow[];
  limit: number;
  offset: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function normalizeLimit(limit?: number): number {
  if (limit === undefined || limit === null || Number.isNaN(limit)) {
    return DEFAULT_LIMIT;
  }
  const parsed = Math.floor(limit);
  if (parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

function normalizeOffset(offset?: number): number {
  if (offset === undefined || offset === null || Number.isNaN(offset)) {
    return 0;
  }
  const parsed = Math.floor(offset);
  return parsed < 0 ? 0 : parsed;
}

@Injectable()
export class AdminFeesService {
  async getOwedFees(query: OwedFeesQuery = {}): Promise<OwedFeesResult> {
    const limit = normalizeLimit(query.limit);
    const offset = normalizeOffset(query.offset);

    const { rows } = await pool.query<OwedFeesRow>(
      `SELECT m.id AS merchant_id,
              m.name AS merchant_name,
              m.email AS merchant_email,
              m.status AS merchant_status,
              p.fee_asset_code,
              p.fee_asset_issuer,
              SUM(p.fee_owed_raw) AS total_owed,
              MIN(p.created_at) AS oldest_owed_at,
              EXISTS (
                SELECT 1 FROM fee_settlements fs WHERE fs.merchant_id = m.id AND fs.status = 'disputed'
              ) AS has_disputed_settlement,
              (
                SELECT COUNT(*)::int FROM fee_settlements fs WHERE fs.merchant_id = m.id AND fs.status = 'disputed'
              ) AS disputed_settlement_count
         FROM payments p
         JOIN merchants m ON m.id = p.merchant_id
        WHERE p.fee_status = 'owed' AND p.status = 'paid'
        GROUP BY m.id, m.name, m.email, m.status, p.fee_asset_code, p.fee_asset_issuer
        ORDER BY oldest_owed_at ASC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    return { data: rows, limit, offset };
  }

  // Settlements a merchant has disputed before signing, with their
  // constituent payment line items so an admin can see exactly what's being
  // contested. Restored verbatim (see #55) from the raw SQL that used to
  // live directly in the controller.
  async listDisputed(): Promise<DisputedSettlementRow[]> {
    const { rows } = await pool.query<DisputedSettlementRow>(
      `SELECT fs.id AS settlement_id, fs.merchant_id, m.name, m.email,
              fs.tx_hash, fs.created_at, fs.unsigned_xdr,
              COALESCE(json_agg(json_build_object(
                'asset_code', p.fee_asset_code,
                'asset_issuer', p.fee_asset_issuer,
                'amount', i.amount::text
              )) FILTER (WHERE i.payment_id IS NOT NULL), '[]'::json) AS totals
         FROM fee_settlements fs
         JOIN merchants m ON m.id = fs.merchant_id
         LEFT JOIN fee_settlement_items i ON i.settlement_id = fs.id
         LEFT JOIN payments p ON p.id = i.payment_id
        WHERE fs.status = 'disputed'
        GROUP BY fs.id, fs.merchant_id, m.name, m.email
        ORDER BY fs.created_at DESC`,
    );

    return rows;
  }
}
