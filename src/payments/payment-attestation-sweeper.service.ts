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

// Retry pacing for a payment whose attestation keeps failing (#68). Without
// this, a permanently-failing row is re-picked first every sweep (ORDER BY
// created_at ASC) and can starve newer payments out of every batch. A
// failure backs off exponentially from one sweep interval up to the cap;
// past MAX_ATTESTATION_FAILURES the row is dead-lettered -- no longer
// selected at all -- and left for a human via the stuck-attestation admin
// notification. Same shape as ChannelKeeperService's keeper backoff.
const ATTESTATION_BACKOFF_BASE_MS = 2 * 60_000;
const ATTESTATION_BACKOFF_CAP_MS = 60 * 60_000;
const MAX_ATTESTATION_FAILURES = 10;

// `failureCount` includes the failure being scheduled (so it's >= 1).
// +/-20% jitter so rows that started failing together during one RPC outage
// don't all retry on the same sweep when it recovers.
export function attestationBackoffMs(failureCount: number, random: () => number = Math.random): number {
  const base = Math.min(ATTESTATION_BACKOFF_CAP_MS, ATTESTATION_BACKOFF_BASE_MS * 2 ** Math.max(0, failureCount - 1));
  return Math.round(base * (0.8 + 0.4 * random()));
}

interface AttestationDueRow {
  id: string;
  payer_address: string;
  muxed_id: string;
  net_usdc: string;
  tx_hash: string;
  merchant_address: string;
  attestation_failure_count: number;
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
      `SELECT p.id, p.payer_address, p.muxed_id, p.net_usdc, p.tx_hash, m.stellar_base_address AS merchant_address,
              p.attestation_failure_count
       FROM payments p
       JOIN merchants m ON m.id = p.merchant_id
       WHERE p.status = 'paid' AND p.attested_at IS NULL
         AND p.attestation_failure_count < $2
         AND (p.attestation_next_attempt_at IS NULL OR p.attestation_next_attempt_at <= NOW())
       ORDER BY p.created_at ASC
       LIMIT $1`,
      [BATCH_SIZE, MAX_ATTESTATION_FAILURES],
    );

    for (const row of rows) {
      if (!row.merchant_address) {
        // Shouldn't happen in practice -- payments.service.ts already
        // requires a merchant to have a stellar_base_address before it'll
        // build a checkout transaction for them -- but a merchant record
        // could theoretically change after the fact. Skip rather than
        // attest with a null address; leaves the row for a human to
        // investigate via the stuck-attestation admin notification below.
        // Recorded as a failure too, so a merchant that never gets an
        // address can't occupy a batch slot on every sweep forever.
        this.logger.warn(`payment ${row.id} has no merchant address on file, skipping attestation`);
        await this.recordFailure(row, 'missing_merchant_address');
        continue;
      }

      try {
        const result = await this.attestation.attest({
          merchantAddress: row.merchant_address,
          payerAddress: row.payer_address,
          muxedId: row.muxed_id,
          netUsdc: row.net_usdc,
          txHash: row.tx_hash,
        });

        if (!result.success) {
          this.logger.warn(`attestation failed for payment ${row.id}: ${result.errorReason}`);
          await this.recordFailure(row, result.errorReason);
          continue;
        }

        await pool.query(
          `UPDATE payments SET onchain_payment_id = $2, attested_at = NOW() WHERE id = $1 AND attested_at IS NULL`,
          [row.id, result.onchainPaymentId],
        );
      } catch (err) {
        // One row's failure -- attestation or the write-back after it --
        // must never abort the rest of the batch. Recorded and backed off
        // like any other failure so it can't starve the rest of the backlog.
        this.logger.error(`attestation errored for payment ${row.id}: ${err}`);
        await this.recordFailure(row, String(err));
      }
    }
  }

  // `previousFailures` comes from the row read at the start of this sweep;
  // sweeps never overlap (advisory lock), so nothing else can have changed
  // it in between. Past MAX_ATTESTATION_FAILURES the row drops out of the
  // sweep's WHERE clause entirely (dead-lettered) and is only visible to a
  // human via the stuck-attestation admin notification.
  private async recordFailure(row: AttestationDueRow, errorReason: string | undefined): Promise<void> {
    const failures = row.attestation_failure_count + 1;
    const delayMs = attestationBackoffMs(failures);
    try {
      await pool.query(
        `UPDATE payments
         SET attestation_failure_count = $2, attestation_last_error = $3,
             attestation_last_attempt_at = NOW(),
             attestation_next_attempt_at = NOW() + ($4 * INTERVAL '1 millisecond')
         WHERE id = $1 AND attested_at IS NULL`,
        [row.id, failures, errorReason ?? null, delayMs],
      );
      if (failures >= MAX_ATTESTATION_FAILURES) {
        this.logger.error(
          `payment ${row.id} dead-lettered after ${failures} attestation failures: ${errorReason}`,
        );
      }
    } catch (err) {
      this.logger.error(`failed to record attestation failure for payment ${row.id}: ${err}`);
    }
  }
}
