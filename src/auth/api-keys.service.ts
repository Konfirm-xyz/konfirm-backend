import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db/pool';

// Keys are prefixed so they are recognisable in logs/leaks and so a bearer
// token can be told apart from a session JWT at a glance.
const KEY_PREFIX = 'konfirm_live_';
// 32 random bytes → 64 hex chars. Only the SHA-256 of the full key is stored.
const KEY_BYTES = 32;
// How much of the key is kept in clear for display in the UI.
const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 4;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

@Injectable()
export class ApiKeysService {
  // Returns the raw key exactly once — it is never recoverable afterwards.
  async create(merchantId: string, name: string): Promise<{ api_key: string; key: ApiKeyRecord }> {
    const raw = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString('hex')}`;
    const { rows } = await pool.query(
      `INSERT INTO merchant_api_keys (merchant_id, name, key_prefix, key_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, key_prefix, last_used_at, revoked_at, created_at`,
      [merchantId, name, raw.slice(0, DISPLAY_PREFIX_LENGTH), sha256(raw)],
    );
    return { api_key: raw, key: rows[0] };
  }

  async list(merchantId: string): Promise<ApiKeyRecord[]> {
    const { rows } = await pool.query(
      `SELECT id, name, key_prefix, last_used_at, revoked_at, created_at
       FROM merchant_api_keys
       WHERE merchant_id = $1
       ORDER BY created_at DESC`,
      [merchantId],
    );
    return rows;
  }

  async revoke(merchantId: string, keyId: string): Promise<void> {
    const { rowCount } = await pool.query(
      `UPDATE merchant_api_keys
       SET revoked_at = NOW()
       WHERE id = $1 AND merchant_id = $2 AND revoked_at IS NULL`,
      [keyId, merchantId],
    );
    if (!rowCount) throw new NotFoundException('API key not found');
  }

  // Resolves a raw bearer key to its merchant. Returns null for unknown or
  // revoked keys; the caller decides how to reject.
  async resolve(rawKey: string): Promise<{ merchantId: string; keyId: string } | null> {
    if (!rawKey.startsWith(KEY_PREFIX)) return null;
    const { rows } = await pool.query(
      `SELECT id, merchant_id FROM merchant_api_keys
       WHERE key_hash = $1 AND revoked_at IS NULL`,
      [sha256(rawKey)],
    );
    if (!rows[0]) return null;
    // Best-effort usage timestamp; a failure here must not fail the request.
    await pool
      .query('UPDATE merchant_api_keys SET last_used_at = NOW() WHERE id = $1', [rows[0].id])
      .catch(() => undefined);
    return { merchantId: rows[0].merchant_id, keyId: rows[0].id };
  }
}

export { KEY_PREFIX as API_KEY_PREFIX, sha256 as hashApiKey };
