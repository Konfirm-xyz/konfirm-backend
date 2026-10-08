import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { pool } from '../db/pool';
import { ChannelService } from './channel.service';

// The on-chain channel contract was deployed with challenge_period_secs =
// 86400 (24h) — see konfirm-contracts/README.md. There's no on-chain getter
// for this, so it's duplicated here rather than fetched; if the deployed
// value ever changes, this constant has to change with it.
const CHALLENGE_PERIOD_SECS = 86_400;

// Arbitrary but stable pg_advisory_lock key, namespaced away from any other
// advisory lock this codebase might use in the future.
const KEEPER_LOCK_KEY = 402_001;

interface ChannelRow {
  onchain_channel_id: string;
  claimed: string;
  pending_amount: string;
  pending_nonce: string;
  pending_signature: string | null;
  status: string;
}

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
// Idle-close is NOT implemented here. This is a real architectural gap
// found while building this, not a deferred nice-to-have: initiate_close()
// requires require_auth() from the channel's payer or payee specifically
// (konfirm-contracts/contracts/channel/src/lib.rs:222-227) — the
// facilitator is neither party in the general case (an agent pays a
// resource server; Konfirm just relays), so there is no live signature for
// the keeper to relay on an idle channel, unlike checkpoint()/
// finalize_close(), which need no party auth at all. logIdleChannels()
// below still surfaces idle channels so the gap is visible operationally,
// but does not attempt (and fail) an initiate_close() call the keeper has
// no authority to make. The real fix needs an open-time or contract design
// change (e.g. an optional delegated-closer address captured by
// open_channel) — out of scope here since it touches the deployed
// contract, not just the backend.
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
        await this.logIdleChannels();
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
  // sweep — at most a 2-minute settlement lag, which is the simple,
  // schema-supported cadence decided at implementation time (the plan left
  // "amount/count vs. time threshold" open; there's no per-checkpoint
  // timestamp or request-count column to base a fancier threshold on, and
  // adding one isn't justified by anything this pass actually needs).
  private async sweepCheckpointsDue(): Promise<void> {
    const { rows } = await pool.query<ChannelRow>(
      `SELECT onchain_channel_id, claimed, pending_amount, pending_nonce, pending_signature, status
       FROM x402_channels
       WHERE status = 'open' AND pending_amount > claimed AND pending_signature IS NOT NULL`,
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
      `SELECT onchain_channel_id, claimed, pending_amount, pending_nonce, pending_signature, status
       FROM x402_channels
       WHERE status = 'closing' AND pending_amount > claimed AND pending_signature IS NOT NULL`,
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
    if (!result.success) {
      this.logger.warn(`checkpoint failed for channel ${row.onchain_channel_id}: ${result.errorReason}`);
    }
    await this.resyncFromChain(onchainChannelId);
  }

  // Any channel mid-close past its challenge period gets finalized —
  // finalize_close() is fully permissionless, so this needs no relay.
  private async sweepFinalizeDue(): Promise<void> {
    const { rows } = await pool.query<{ onchain_channel_id: string; closing_at: string }>(
      `SELECT onchain_channel_id, EXTRACT(EPOCH FROM closing_at)::bigint AS closing_at
       FROM x402_channels
       WHERE status = 'closing' AND closing_at IS NOT NULL
         AND closing_at + ($1 * INTERVAL '1 second') <= NOW()`,
      [CHALLENGE_PERIOD_SECS],
    );
    for (const row of rows) {
      const onchainChannelId = BigInt(row.onchain_channel_id);
      const result = await this.channel.finalizeCloseChannel(onchainChannelId);
      if (!result.success) {
        this.logger.warn(`finalize_close failed for channel ${row.onchain_channel_id}: ${result.errorReason}`);
      }
      await this.resyncFromChain(onchainChannelId);
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

  // No auto-close attempted (see module comment) — this only makes the gap
  // visible operationally instead of silent, so a human can decide whether
  // to reach out to the resource server (the likely payee-side operator)
  // to request a close, or accept the channel sitting open.
  private async logIdleChannels(): Promise<void> {
    const { rows } = await pool.query<{ onchain_channel_id: string; idle_days: number }>(
      `SELECT onchain_channel_id, EXTRACT(DAY FROM NOW() - last_activity_at)::int AS idle_days
       FROM x402_channels
       WHERE status = 'open' AND last_activity_at < NOW() - INTERVAL '168 hours'`,
    );
    for (const row of rows) {
      this.logger.warn(
        `channel ${row.onchain_channel_id} idle for ${row.idle_days} days — no automatic close ` +
          `(facilitator is not a channel party; see module comment). Manual /x402/channel/close needed.`,
      );
    }
  }
}
