import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Asset, BASE_FEE, Horizon, Memo, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { platformFeeAddress } from '../common/platform-fee';
import { HORIZON_URL, NETWORK_PASSPHRASE } from '../common/stellar-network';
import { fromStroops, toStroops } from '../common/money-rules';

// Owed platform fees (docs/design/qr-fee-collection.md, Option B). A payer who
// pays a link by QR pays the link amount only, so the fee is recorded as owed.
// The merchant clears it by signing one transaction from their own account to
// the fee account. Konfirm builds that transaction and submits what the
// merchant signed, but never holds the merchant's key.
//
// Lifecycle: a payment's fee goes owed -> claimed (in a pending settlement the
// merchant hasn't signed yet) -> settled (the settlement is on-chain). A
// settlement that expires unsigned releases its claims back to owed.

const SETTLEMENT_TTL_SECONDS = 15 * 60;
const SETTLEMENT_MEMO = 'Konfirm fees';

export interface OwedTotal {
  asset_code: string;
  asset_issuer: string | null;
  amount: string;
  payments: number;
}

interface PaymentFeeRow {
  id: string;
  fee_owed_raw: string;
  fee_asset_code: string;
  fee_asset_issuer: string | null;
}

// Builds the Stellar asset for a stored fee. Native XLM has no issuer.
export function assetFor(code: string, issuer: string | null): Asset {
  return code === 'XLM' ? Asset.native() : new Asset(code, issuer as string);
}

// Sums owed fees per asset. Pure, so the arithmetic is tested directly.
export function totalsByAsset(rows: PaymentFeeRow[]): Array<{ code: string; issuer: string | null; amount: string; payments: number }> {
  const byKey = new Map<string, { code: string; issuer: string | null; sum: bigint; payments: number }>();
  for (const r of rows) {
    const key = `${r.fee_asset_code}:${r.fee_asset_issuer ?? ''}`;
    const stroops = toStroops(r.fee_owed_raw);
    const existing = byKey.get(key) ?? { code: r.fee_asset_code, issuer: r.fee_asset_issuer, sum: 0n, payments: 0 };
    existing.sum += stroops;
    existing.payments += 1;
    byKey.set(key, existing);
  }
  return [...byKey.values()].map((v) => ({ code: v.code, issuer: v.issuer, amount: fromStroops(v.sum), payments: v.payments }));
}

@Injectable()
export class FeesService {
  private readonly logger = new Logger(FeesService.name);
  private readonly horizon = new Horizon.Server(HORIZON_URL);

  async owed(merchantId: string): Promise<{ totals: OwedTotal[]; payments: number }> {
    const { rows } = await pool.query<PaymentFeeRow>(
      `SELECT id, fee_owed_raw::text, fee_asset_code, fee_asset_issuer
       FROM payments WHERE merchant_id = $1 AND fee_status = 'owed' AND status = 'paid'`,
      [merchantId],
    );
    const totals = totalsByAsset(rows).map((t) => ({
      asset_code: t.code,
      asset_issuer: t.issuer,
      amount: t.amount,
      payments: t.payments,
    }));
    return { totals, payments: rows.length };
  }

  // Builds the settlement for everything currently owed. If a settlement is
  // already waiting for the merchant's signature, returns that one, so a
  // double click doesn't create a second transaction over the same fees.
  async createSettlement(merchantId: string) {
    const merchantRes = await pool.query('SELECT stellar_base_address FROM merchants WHERE id = $1', [merchantId]);
    const merchantAddress: string | null = merchantRes.rows[0]?.stellar_base_address ?? null;
    if (!merchantAddress) throw new BadRequestException('add a Stellar address to your account before settling fees');

    const existing = await pool.query(
      `SELECT id, unsigned_xdr, expires_at FROM fee_settlements
       WHERE merchant_id = $1 AND status = 'pending' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [merchantId],
    );
    if (existing.rows[0]) {
      const s = existing.rows[0];
      return this.describeSettlement(s.id, s.unsigned_xdr, s.expires_at, merchantId);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // One settlement build per merchant at a time, so two requests can't both
      // claim the same owed payments.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`fees:${merchantId}`]);
      const { rows } = await client.query<PaymentFeeRow>(
        `SELECT id, fee_owed_raw::text, fee_asset_code, fee_asset_issuer
         FROM payments WHERE merchant_id = $1 AND fee_status = 'owed' AND status = 'paid'
         FOR UPDATE`,
        [merchantId],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFoundException('no fees are owed');
      }

      const totals = totalsByAsset(rows);
      const builder = await this.buildUnsigned(merchantAddress, totals);
      const tx = builder.build();
      const expiresAt = new Date((tx.timeBounds ? Number(tx.timeBounds.maxTime) : Math.floor(Date.now() / 1000) + SETTLEMENT_TTL_SECONDS) * 1000);
      const unsignedXdr = tx.toXDR();
      const txHash = Buffer.from(tx.hash()).toString('hex');

      const ins = await client.query(
        `INSERT INTO fee_settlements (merchant_id, tx_hash, unsigned_xdr, expires_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [merchantId, txHash, unsignedXdr, expiresAt],
      );
      const settlementId = ins.rows[0].id;
      await client.query(
        `UPDATE payments SET fee_status = 'claimed', fee_settlement_id = $2
         WHERE id = ANY($1::uuid[])`,
        [rows.map((r) => r.id), settlementId],
      );
      await client.query('COMMIT');
      return this.describeSettlement(settlementId, unsignedXdr, expiresAt, merchantId);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // Each owed asset gets one payment operation from the merchant to the fee
  // account. The merchant's own account is the source, so no fee is paid from
  // Konfirm's side.
  private async buildUnsigned(merchantAddress: string, totals: Array<{ code: string; issuer: string | null; amount: string }>) {
    const account = await this.horizon.loadAccount(merchantAddress);
    const feeAddress = platformFeeAddress();
    const builder = new TransactionBuilder(account, {
      fee: String(Number(BASE_FEE) * totals.length),
      networkPassphrase: NETWORK_PASSPHRASE,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + SETTLEMENT_TTL_SECONDS },
    });
    for (const t of totals) {
      builder.addOperation(
        Operation.payment({ destination: feeAddress, asset: assetFor(t.code, t.issuer), amount: t.amount }),
      );
    }
    builder.addMemo(Memo.text(SETTLEMENT_MEMO));
    return builder;
  }

  private async describeSettlement(id: string, unsignedXdr: string, expiresAt: Date, merchantId: string) {
    const owed = await this.owed(merchantId);
    return {
      settlement_id: id,
      unsigned_xdr: unsignedXdr,
      network_passphrase: NETWORK_PASSPHRASE,
      expires_at: expiresAt,
      totals: owed.totals,
    };
  }

  // Submits what the merchant signed. The signed transaction's hash must equal
  // the hash recorded when the settlement was built, so the merchant can't
  // swap in a different transaction. Signatures don't change the hash.
  async submitSigned(merchantId: string, settlementId: string, signedXdr: string) {
    const { rows } = await pool.query(
      `SELECT tx_hash, status, expires_at FROM fee_settlements WHERE id = $1 AND merchant_id = $2`,
      [settlementId, merchantId],
    );
    const s = rows[0];
    if (!s) throw new NotFoundException('settlement not found');
    if (s.status !== 'pending') throw new ConflictException(`this settlement is already ${s.status}`);
    if (new Date(s.expires_at) <= new Date()) throw new ConflictException('this settlement expired — create a new one');

    const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    if (Buffer.from(tx.hash()).toString('hex') !== s.tx_hash) {
      throw new BadRequestException('the signed transaction is not the one Konfirm built for this settlement');
    }
    try {
      await this.horizon.submitTransaction(tx);
    } catch (err) {
      const codes = (err as { response?: { data?: { extras?: { result_codes?: unknown } } } })?.response?.data?.extras?.result_codes;
      throw new BadRequestException({
        message: 'the network rejected the settlement',
        result_codes: codes ?? null,
      });
    }
    await this.confirm(settlementId);
    return { ok: true, settlement_id: settlementId, tx_hash: s.tx_hash };
  }

  private async confirm(settlementId: string, client: { query: PoolClient['query'] } = pool) {
    await client.query(`UPDATE fee_settlements SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1 AND status = 'pending'`, [settlementId]);
    await client.query(`UPDATE payments SET fee_status = 'settled' WHERE fee_settlement_id = $1`, [settlementId]);
  }

  // Runs on a schedule. A settlement the merchant signed and submitted outside
  // the app (for example from another wallet tool) is picked up here, because
  // its hash is already known. A settlement that expired unsigned releases its
  // claims back to owed.
  async sweepPending(): Promise<{ confirmed: number; expired: number }> {
    const { rows } = await pool.query(
      `SELECT id, tx_hash, expires_at FROM fee_settlements WHERE status = 'pending' ORDER BY created_at LIMIT 200`,
    );
    let confirmed = 0;
    let expired = 0;
    for (const s of rows) {
      const onChain = await this.lookup(s.tx_hash);
      if (onChain?.successful) {
        await this.confirm(s.id);
        confirmed++;
        continue;
      }
      const pastExpiry = new Date(s.expires_at) <= new Date();
      // A failed on-chain record, or no record once the time bound has passed,
      // means the settlement can never land. Release its claims.
      if (onChain?.successful === false || (!onChain && pastExpiry)) {
        await this.release(s.id);
        expired++;
      }
    }
    if (confirmed || expired) this.logger.log(`fee settlements: ${confirmed} confirmed, ${expired} released`);
    return { confirmed, expired };
  }

  private async release(settlementId: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE payments SET fee_status = 'owed', fee_settlement_id = NULL WHERE fee_settlement_id = $1 AND fee_status = 'claimed'`, [settlementId]);
      await client.query(`UPDATE fee_settlements SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [settlementId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // Returns the Horizon record, or null if the transaction isn't on the ledger.
  private async lookup(txHash: string): Promise<{ successful: boolean } | null> {
    try {
      const rec = await this.horizon.transactions().transaction(txHash).call();
      return { successful: rec.successful };
    } catch (err) {
      if ((err as { response?: { status?: number } })?.response?.status === 404) return null;
      throw err;
    }
  }

  async listSettlements(merchantId: string) {
    const { rows } = await pool.query(
      `SELECT id, tx_hash, status, expires_at, confirmed_at, created_at
       FROM fee_settlements WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [merchantId],
    );
    return rows;
  }
}
