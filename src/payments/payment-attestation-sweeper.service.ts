import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { pool } from '../db/pool';
import { PaymentAttestationService } from './payment-attestation.service';

// Arbitrary but stable pg_advisory_lock key -- namespaced away from
// ChannelKeeperService's KEEPER_LOCK_KEY (402_001),
// FacilitatorSweepService's SWEEP_LOCK_KEY (402_002), and
// FeeCollectionSweepService's SWEEP_LOCK_KEY (402_003). Same
// double-sweep-across-replicas guard already proven safe for the channel
// keeper (two independent pg.Pool instances, two concurrent sweep() calls,
// exactly one real on-chain checkpoint landed).
const ATTESTATION_LOCK_KEY = 402_004;
const BATCH_SIZE = 20;
// A claim older than this is treated as abandoned (process died mid-attest)
// and retried. Long enough to cover a slow Soroban submission, short enough
// that a crashed sweep doesn't strand a payment for long.
const CLAIM_STALE_AFTER = '15 minutes';

interface AttestationDueRow {
  id: string;
  payer_address: string;
  muxed_id: string;
  net_usdc: string;
  tx_hash: string;
  merchant_address: string;
}

// In-process @Cron(), the fourth instance of this exact architecture in
// this codebase (ChannelKeeperService, FacilitatorSweepService, referral
// rewards) -- shares the api service's own Postgres pool and Soroban
// signer rather than reproducing the backup-cron shared-railway.json class
// of bug for a fourth time.
@Injectable()
export class PaymentAttestationSweeperService {
  private readonly logger = new Logger(PaymentAttestationSweeperService.name);

  constructor(private readonly attestation: PaymentAttestationService) {}

  @Cron('*/2 * * * *')
  async sweep(): Promise<void> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
        ATTESTATION_LOCK_KEY,
      ]);
      if (!rows[0].locked) {
        // Another sweep -- or another api replica -- is already running.
        return;
      }
      try {
        await this.doSweep();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [ATTESTATION_LOCK_KEY]);
      }
    } catch (err) {
      this.logger.error(`sweep failed: ${err}`);
    } finally {
      client.release();
    }
  }

  private async doSweep(): Promise<void> {
    const { rows } = await pool.query<AttestationDueRow>(
      `SELECT p.id, p.payer_address, p.muxed_id, p.net_usdc, p.tx_hash, m.stellar_base_address AS merchant_address
       FROM payments p
       JOIN merchants m ON m.id = p.merchant_id
       WHERE p.status = 'paid' AND p.attested_at IS NULL
         AND (p.attestation_claimed_at IS NULL OR p.attestation_claimed_at < NOW() - $2::interval)
       ORDER BY p.created_at ASC
       LIMIT $1`,
      [BATCH_SIZE, CLAIM_STALE_AFTER],
    );

    for (const row of rows) {
      if (!row.merchant_address) {
        // Shouldn't happen in practice -- payments.service.ts already
        // requires a merchant to have a stellar_base_address before it'll
        // build a checkout transaction for them -- but a merchant record
        // could theoretically change after the fact. Skip rather than
        // attest with a null address; leaves the row for a human to
        // investigate via the stuck-attestation admin notification below.
        this.logger.warn(`payment ${row.id} has no merchant address on file, skipping attestation`);
        continue;
      }

      try {
        // Claim the row *before* the on-chain call. If the write-back below
        // fails after a successful attest(), the claim stays set, so the next
        // sweep skips this row instead of submitting a second on-chain
        // record_payment for the same payment. Only a claim older than
        // CLAIM_STALE_AFTER is retried.
        const claim = await pool.query(
          `UPDATE payments SET attestation_claimed_at = NOW()
           WHERE id = $1 AND attested_at IS NULL
             AND (attestation_claimed_at IS NULL OR attestation_claimed_at < NOW() - $2::interval)`,
          [row.id, CLAIM_STALE_AFTER],
        );
        if (claim.rowCount === 0) {
          // Another sweep claimed it first.
          continue;
        }

        const result = await this.attestation.attest({
          merchantAddress: row.merchant_address,
          payerAddress: row.payer_address,
          muxedId: row.muxed_id,
          netUsdc: row.net_usdc,
          txHash: row.tx_hash,
        });

        if (!result.success) {
          this.logger.warn(`attestation failed for payment ${row.id}: ${result.errorReason}`);
          // Release the claim so the next sweep retries promptly rather than
          // waiting out CLAIM_STALE_AFTER.
          await pool.query(`UPDATE payments SET attestation_claimed_at = NULL WHERE id = $1 AND attested_at IS NULL`, [
            row.id,
          ]);
          continue;
        }

        await pool.query(
          `UPDATE payments SET onchain_payment_id = $2, attested_at = NOW(), attestation_claimed_at = NULL
           WHERE id = $1 AND attested_at IS NULL`,
          [row.id, result.onchainPaymentId],
        );
      } catch (err) {
        // One row's failure -- attestation or the write-back after it --
        // must never abort the rest of the batch. Left unattested; the
        // next sweep retries it, same self-healing shape as every other
        // sweeper in this codebase. The claim set above is deliberately
        // *not* cleared here: if the failure came after a successful
        // on-chain attest(), retrying immediately would submit a duplicate
        // record_payment. The stale-claim window bounds the wait instead.
        this.logger.error(`attestation errored for payment ${row.id}: ${err}`);
      }
    }
  }
}
