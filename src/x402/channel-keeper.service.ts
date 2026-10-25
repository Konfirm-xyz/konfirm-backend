import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { pool } from '../db/pool';
import { getFacilitatorSigner } from '../common/facilitator-signer';
import { ChannelService, FacilitatorCallResult } from './channel.service';

// The on-chain channel contract was deployed with challenge_period_secs =
// 86400 (24h) — see konfirm-contracts/README.md. There's no on-chain getter
// for this, so it's duplicated here rather than fetched; if the deployed
// value ever changes, this constant has to change with it.
const CHALLENGE_PERIOD_SECS = 86_400;

// Arbitrary but stable pg_advisory_lock key, namespaced away from any other
// advisory lock this codebase might use in the future.
const KEEPER_LOCK_KEY = 402_001;

// Retry pacing for a channel whose checkpoint/finalize keeps failing. A
// transient failure backs off exponentially from one sweep interval up to
// the cap; a terminal one goes straight to the cap. Both are still retried
// at the cap, never abandoned outright: on-chain state can move underneath
// (a new claim, a status change picked up by resync), and the keeper is the
// only thing that will ever submit these. The 1h cap is well inside the 24h
// challenge period, so it can't cost the watchtower its window.
const BACKOFF_BASE_MS = 2 * 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;
// Consecutive failures after which a channel is reported as stuck every
// sweep, the same way logIdleChannels() reports idle ones.
const STUCK_FAILURE_THRESHOLD = 5;

export type KeeperFailureKind = 'terminal' | 'transient';

// errorReason values come from ChannelService.submitFacilitatorCall,
// prefixed with the operation ('checkpoint_', 'finalize_close_').
//
// Terminal: the contract or the network looked at exactly this call and
// rejected it. A simulation failure is the contract refusing these args
// against current on-chain state (stale claim, bad signature, challenge
// period not over, wrong channel status); a transaction failure is the
// same verdict after submission. Resubmitting the same thing two minutes
// later gets the same answer.
//
// Transient: nothing about the call itself was judged. Signing (KMS),
// submission refused by the RPC, an exception reaching the RPC at all, or a
// confirmation poll that ran out of time with the transaction possibly
// still landing. Anything unrecognised is treated as transient too, so it
// keeps retrying (with backoff) rather than being written off.
export function classifyKeeperFailure(errorReason: string | undefined): KeeperFailureKind {
  if (errorReason && (errorReason.endsWith('_simulation_failed') || errorReason.endsWith('_transaction_failed'))) {
    return 'terminal';
  }
  return 'transient';
}

// `failureCount` includes the failure being scheduled (so it's >= 1).
// +/-20% jitter so channels that started failing together during one RPC
// outage don't all retry on the same sweep when it recovers.
export function keeperBackoffMs(kind: KeeperFailureKind, failureCount: number, random: () => number = Math.random): number {
  const base =
    kind === 'terminal' ? BACKOFF_CAP_MS : Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failureCount - 1));
  return Math.round(base * (0.8 + 0.4 * random()));
}

interface ChannelRow {
  onchain_channel_id: string;
  claimed: string;
  pending_amount: string;
  pending_nonce: string;
  pending_signature: string | null;
  status: string;
  keeper_failure_count: number;
}

// Channels the keeper is not currently backing off from.
const ATTEMPT_DUE = '(keeper_next_attempt_at IS NULL OR keeper_next_attempt_at <= NOW())';

// checkpoint() and finalize_close() are both fully permissionless (see
// channel.service.ts's comment on checkpointChannel/finalizeCloseChannel),
// so the facilitator can drive them on its own authority with no live
// party signature needed. In-process @Cron(), not a separate Railway
// service — deliberate, see the approved plan (Step 4): a standalone
// "channel-keeper" service would need its own railwayConfigFile, deploy
// pipeline, and crash/restart story, which is exactly the extra surface
// that caused a real multi-day production bug elsewhere in this codebase
// (backup-cron silently sharing api's root railway.json). The keeper needs
// the same Postgres pool and Soroban signer api already owns, so coupling
// its uptime to api's restarts is a reasonable, explicit trade.
//
// Idle-close: the contract was redeployed (PRD docs/PRD.md M2) with the
// open-time delegated-closer this module's previous comment said was the
// real fix needed — initiate_close() now accepts a caller who is neither
// payer nor payee, as long as the channel's delegated_closer equals that
// caller (konfirm-contracts/contracts/channel/src/lib.rs's
// initiate_close). ChannelService.openChannel() records whether the payer
// actually granted that to this facilitator (column: delegated_closer on
// x402_channels); sweepIdleClose() below only attempts initiate_close on
// channels where it was. A payer who declined just has no idle-close
// safety net for that channel — logIdleChannels() still reports those so
// the gap stays visible operationally, same as before.
@Injectable()
export class ChannelKeeperService {
  private readonly logger = new Logger(ChannelKeeperService.name);

  constructor(private readonly channel: ChannelService) {}

  @Cron('*/2 * * * *')
  async sweep(): Promise<void> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
        KEEPER_LOCK_KEY,
      ]);
      if (!rows[0].locked) {
        // Another sweep — or another api replica — is already running.
        // Never overlap; see the plan's explicit crash-safety requirement.
        return;
      }
      try {
        await this.sweepCheckpointsDue();
        await this.sweepFinalizeDue();
        await this.sweepWatchtower();
        await this.sweepIdleClose();
        await this.logIdleChannels();
        await this.logStuckChannels();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [KEEPER_LOCK_KEY]);
      }
    } catch (err) {
      this.logger.error(`sweep failed: ${err}`);
    } finally {
      client.release();
    }
  }

  // Any open channel with an unsettled claim gets checkpointed every
  // sweep (unless it's backing off after failures — see recordAttempt) —
  // at most a 2-minute settlement lag, which is the simple,
  // schema-supported cadence decided at implementation time (the plan left
  // "amount/count vs. time threshold" open; there's no per-checkpoint
  // timestamp or request-count column to base a fancier threshold on, and
  // adding one isn't justified by anything this pass actually needs).
  private async sweepCheckpointsDue(): Promise<void> {
    const { rows } = await pool.query<ChannelRow>(
      `SELECT onchain_channel_id, claimed, pending_amount, pending_nonce, pending_signature, status, keeper_failure_count
       FROM x402_channels
       WHERE status = 'open' AND pending_amount > claimed AND pending_signature IS NOT NULL AND ${ATTEMPT_DUE}`,
    );
    for (const row of rows) {
      await this.checkpointAndResync(row);
    }
  }

  // Any channel mid-close whose best-known claim exceeds what's actually
  // checkpointed on-chain gets defended immediately — this is what makes
  // the payee safe against a stale/malicious close with no new trust
  // assumption: Konfirm already holds the latest signed claim as an
  // ordinary side effect of /x402/channel/claim.
  private async sweepWatchtower(): Promise<void> {
    const { rows } = await pool.query<ChannelRow>(
      `SELECT onchain_channel_id, claimed, pending_amount, pending_nonce, pending_signature, status, keeper_failure_count
       FROM x402_channels
       WHERE status = 'closing' AND pending_amount > claimed AND pending_signature IS NOT NULL AND ${ATTEMPT_DUE}`,
    );
    for (const row of rows) {
      this.logger.warn(`watchtower: defending pending claim for closing channel ${row.onchain_channel_id}`);
      await this.checkpointAndResync(row);
    }
  }

  // Captures the exact (amount, nonce, signature) triple at read time (the
  // row passed in), submits exactly that — never re-reads pending_amount
  // after the RPC round-trip, since a newer claim can land via
  // /x402/channel/claim while the checkpoint transaction is in flight.
  // Resyncs `claimed`/`status` from on-chain truth after every attempt,
  // success or failure — the contract's own StaleClaim rejection on a
  // redundant resubmission is a safety net, not the primary correctness
  // mechanism, so a crash between the on-chain confirmation and this write
  // has to be self-healing on the next sweep regardless.
  private async checkpointAndResync(row: ChannelRow): Promise<void> {
    const onchainChannelId = BigInt(row.onchain_channel_id);
    const result = await this.channel.checkpointChannel({
      onchainChannelId,
      cumulativeAmount: BigInt(row.pending_amount),
      nonce: BigInt(row.pending_nonce),
      signature: Buffer.from(row.pending_signature as string, 'hex'),
    });
    await this.recordAttempt(onchainChannelId, 'checkpoint', row.keeper_failure_count, result);
    await this.resyncFromChain(onchainChannelId);
  }

  // Any channel mid-close past its challenge period gets finalized —
  // finalize_close() is fully permissionless, so this needs no relay.
  private async sweepFinalizeDue(): Promise<void> {
    const { rows } = await pool.query<{ onchain_channel_id: string; closing_at: string; keeper_failure_count: number }>(
      `SELECT onchain_channel_id, EXTRACT(EPOCH FROM closing_at)::bigint AS closing_at, keeper_failure_count
       FROM x402_channels
       WHERE status = 'closing' AND closing_at IS NOT NULL
         AND closing_at + ($1 * INTERVAL '1 second') <= NOW() AND ${ATTEMPT_DUE}`,
      [CHALLENGE_PERIOD_SECS],
    );
    for (const row of rows) {
      const onchainChannelId = BigInt(row.onchain_channel_id);
      const result = await this.channel.finalizeCloseChannel(onchainChannelId);
      await this.recordAttempt(onchainChannelId, 'finalize_close', row.keeper_failure_count, result);
      await this.resyncFromChain(onchainChannelId);
    }
  }

  // A success clears the channel's failure state. A failure is classified,
  // logged at a level matching its kind, and schedules the next attempt —
  // the sweep queries skip the channel until then. `previousFailures` comes
  // from the row read at the start of this sweep; sweeps never overlap
  // (advisory lock), so nothing else can have changed it in between.
  private async recordAttempt(
    onchainChannelId: bigint,
    operation: string,
    previousFailures: number,
    result: FacilitatorCallResult,
  ): Promise<void> {
    try {
      if (result.success) {
        await pool.query(
          `UPDATE x402_channels
           SET keeper_failure_count = 0, keeper_last_error = NULL, keeper_last_error_kind = NULL,
               keeper_next_attempt_at = NULL
           WHERE onchain_channel_id = $1`,
          [onchainChannelId.toString()],
        );
        return;
      }
      const kind = classifyKeeperFailure(result.errorReason);
      const failures = previousFailures + 1;
      const delayMs = keeperBackoffMs(kind, failures);
      const message =
        `${operation} failed (${kind}) for channel ${onchainChannelId}: ${result.errorReason} — ` +
        `failure ${failures} in a row, next attempt in ${Math.round(delayMs / 1000)}s`;
      if (kind === 'terminal') this.logger.error(message);
      else this.logger.warn(message);
      await pool.query(
        `UPDATE x402_channels
         SET keeper_failure_count = $2, keeper_last_error = $3, keeper_last_error_kind = $4,
             keeper_next_attempt_at = NOW() + ($5 * INTERVAL '1 millisecond')
         WHERE onchain_channel_id = $1`,
        [onchainChannelId.toString(), failures, result.errorReason ?? null, kind, delayMs],
      );
    } catch (err) {
      // Same reasoning as resyncFromChain: never let bookkeeping throw out
      // of the sweep and skip the remaining channels.
      this.logger.error(`recording keeper attempt failed for channel ${onchainChannelId}: ${err}`);
    }
  }

  // Self-healing resync: on-chain get_channel_info() is the source of
  // truth for claimed/status regardless of what the last attempt's
  // success/failure result said. Soroban decodes a data-less enum variant
  // (ChannelStatus::Open, etc.) as a single-element array — verified
  // directly against this exact contract's real return value before
  // trusting it, the same quirk Arbiter's decodeStatus() documents for its
  // own escrow contract, not assumed to be the same just because it's
  // "probably similar."
  private async resyncFromChain(onchainChannelId: bigint): Promise<void> {
    try {
      const info = (await this.channel.getChannelInfoOnChain(onchainChannelId)) as {
        claimed: bigint;
        status: string[] | string;
      };
      const status = Array.isArray(info.status) ? info.status[0] : info.status;
      const mappedStatus = { Open: 'open', Closing: 'closing', Closed: 'closed', Held: 'held' }[status] ?? null;
      await pool.query(
        `UPDATE x402_channels
         SET claimed = $2, status = COALESCE($3, status), updated_at = NOW()
         WHERE onchain_channel_id = $1`,
        [onchainChannelId.toString(), info.claimed.toString(), mappedStatus],
      );
    } catch (err) {
      // A failed resync just leaves the row stale until the next sweep —
      // never let an on-chain read failure here throw out of the sweep and
      // skip whatever else was queued.
      this.logger.error(`resync failed for channel ${onchainChannelId}: ${err}`);
    }
  }

  // Channels idle 7+ days where the payer granted this facilitator
  // delegated_closer at open time (see openChannel's delegatedCloser
  // check) — the one case where the keeper actually has the authority to
  // start the close itself. initiate_close() is idempotent against
  // already-closing/closed channels (NotOpen), so re-attempting one that
  // moved on since the row was read just fails harmlessly and clears on
  // the next resync.
  private async sweepIdleClose(): Promise<void> {
    const signer = await getFacilitatorSigner();
    const { rows } = await pool.query<{ onchain_channel_id: string; keeper_failure_count: number }>(
      `SELECT onchain_channel_id, keeper_failure_count
       FROM x402_channels
       WHERE status = 'open' AND delegated_closer = $1
         AND last_activity_at < NOW() - INTERVAL '168 hours' AND ${ATTEMPT_DUE}`,
      [signer.address],
    );
    for (const row of rows) {
      const onchainChannelId = BigInt(row.onchain_channel_id);
      const result = await this.channel.initiateCloseAsDelegate(onchainChannelId);
      await this.recordAttempt(onchainChannelId, 'initiate_close', row.keeper_failure_count, result);
      await this.resyncFromChain(onchainChannelId);
    }
  }

  // Channels idle 7+ days with no delegated_closer granted — the keeper has
  // no authority to close these (see module comment), so this only makes
  // the gap visible operationally instead of silent, so a human can decide
  // whether to reach out to the resource server (the likely payee-side
  // operator) to request a close, or accept the channel sitting open.
  private async logIdleChannels(): Promise<void> {
    const { rows } = await pool.query<{ onchain_channel_id: string; idle_days: number }>(
      `SELECT onchain_channel_id, EXTRACT(DAY FROM NOW() - last_activity_at)::int AS idle_days
       FROM x402_channels
       WHERE status = 'open' AND delegated_closer IS NULL AND last_activity_at < NOW() - INTERVAL '168 hours'`,
    );
    for (const row of rows) {
      this.logger.warn(
        `channel ${row.onchain_channel_id} idle for ${row.idle_days} days — no delegated_closer was ` +
          `granted at open time, so the keeper has no authority to close it. Manual /x402/channel/close needed.`,
      );
    }
  }

  // Escalation for channels the keeper keeps failing on — the operational
  // signal that backoff alone would otherwise hide. Reported every sweep
  // until the channel succeeds or leaves the open/closing states.
  private async logStuckChannels(): Promise<void> {
    const { rows } = await pool.query<{
      onchain_channel_id: string;
      status: string;
      keeper_failure_count: number;
      keeper_last_error: string | null;
      keeper_last_error_kind: string | null;
    }>(
      `SELECT onchain_channel_id, status, keeper_failure_count, keeper_last_error, keeper_last_error_kind
       FROM x402_channels
       WHERE status IN ('open', 'closing') AND keeper_failure_count >= $1`,
      [STUCK_FAILURE_THRESHOLD],
    );
    for (const row of rows) {
      this.logger.error(
        `channel ${row.onchain_channel_id} (${row.status}) stuck: ${row.keeper_failure_count} consecutive keeper ` +
          `failures, last ${row.keeper_last_error_kind}: ${row.keeper_last_error} — needs manual review.`,
      );
    }
  }
}
