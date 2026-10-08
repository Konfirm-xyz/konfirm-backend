/// <reference path="../common/stellar-sdk-contract.d.ts" />
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Address, BASE_FEE, Contract, Networks, TransactionBuilder, nativeToScVal, rpc } from '@stellar/stellar-sdk';
import { Client } from '@stellar/stellar-sdk/contract';
import type { AssembledTransaction, MethodOptions } from '@stellar/stellar-sdk/contract';
import { pool } from '../db/pool';
import { withRetry } from '../common/retry';
import { getFeeCollectionSigner } from '../common/platform-fee';
import { FacilitatorSpendGuardService, FacilitatorHalted, FacilitatorSpendCapExceeded } from './facilitator-spend-guard.service';
import { NETWORK_PASSPHRASE, RPC_URL } from '../common/stellar-network';
import { USDC_SAC_ID, TREASURY_CONTRACT_ID } from '../common/stellar-network';

// USDC's SAC (SEP-41 token contract) on testnet -- same address
// facilitator-sweep.service.ts and admin-treasury.service.ts use.
// The fixed, fund-custodying treasury instance -- same address
// facilitator-sweep.service.ts sweeps into.
const STROOPS_PER_UNIT = 10_000_000;
// Arbitrary but stable pg_advisory_lock key -- namespaced away from
// ChannelKeeperService's KEEPER_LOCK_KEY (402_001) and
// FacilitatorSweepService's own SWEEP_LOCK_KEY (402_002).
const SWEEP_LOCK_KEY = 402_003;

interface SacTokenContract {
  balance(args: { id: string }, options?: MethodOptions): Promise<AssembledTransaction<bigint>>;
}

let clientPromise: Promise<Client & SacTokenContract> | null = null;
function getUsdcClient(publicKey: string): Promise<Client & SacTokenContract> {
  if (!clientPromise) {
    clientPromise = Client.from<SacTokenContract>({
      contractId: USDC_SAC_ID,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      publicKey,
    });
  }
  return clientPromise;
}

/**
 * Sweeps PLATFORM_FEE_ADDRESS's accumulated USDC balance above a configured
 * operating minimum into the treasury contract -- the other half of the
 * checkout fee-split feature (see payments.service.ts's prepareTx): a
 * Soroban contract invocation must be the sole operation in its
 * transaction, so the fee-collection leg at checkout time can only ever be
 * a plain classic Payment, never a direct call into treasury. This sweep is
 * what actually gets that revenue into custody.
 *
 * USDC only, on purpose -- the deployed treasury instance was initialized
 * with a single `token: Address` (USDC), so it cannot custody XLM- or
 * EURC-denominated fee revenue at all. Those balances accumulate on
 * PLATFORM_FEE_ADDRESS unswept; redeploying a per-asset treasury (or adding
 * multi-asset support to the contract) is a real follow-up, not silently
 * covered here.
 *
 * Shares FacilitatorSpendGuardService with FacilitatorSweepService rather
 * than getting its own independent cap: the threat model is identical (a
 * compromised-but-still-legitimate signing process moving money it
 * shouldn't) and a combined daily cap bounds total sweep exfiltration risk
 * regardless of which of the two accounts a compromise happens to touch. A
 * breach here halts both sweeps until an admin resumes -- consistent with
 * that service's own "something is already wrong" posture, not a bug.
 *
 * No withFacilitatorSubmissionLock here -- that guards against a sequence-
 * number race across submissions sharing the *facilitator's* signer/account;
 * PLATFORM_FEE_ADDRESS is a separate account with its own sequence number,
 * so there's nothing to serialize against. The advisory lock below still
 * guards against this cron's own sweep overlapping itself across replicas.
 *
 * In-process @Cron(), same reasoning as every other keeper/sweeper in this
 * codebase (ChannelKeeperService, ReferralRewardsService,
 * FacilitatorSweepService): shares the api service's own Postgres pool, and
 * a standalone service would just reproduce the backup-cron shared-
 * railway.json class of bug this project already hit once.
 */
@Injectable()
export class FeeCollectionSweepService {
  private readonly logger = new Logger(FeeCollectionSweepService.name);

  constructor(private readonly spendGuard: FacilitatorSpendGuardService) {}

  @Cron('*/30 * * * *')
  async sweep(): Promise<void> {
    // Unset means "not configured", not "sweep everything" -- same
    // conservative default as FacilitatorSweepService.
    const minUsdcRaw = process.env.PLATFORM_FEE_SWEEP_MIN_USDC_BALANCE;
    if (minUsdcRaw === undefined) {
      this.logger.debug('PLATFORM_FEE_SWEEP_MIN_USDC_BALANCE not set -- skipping sweep');
      return;
    }

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
        SWEEP_LOCK_KEY,
      ]);
      if (!rows[0].locked) {
        return;
      }
      try {
        await this.doSweep(Number(minUsdcRaw));
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [SWEEP_LOCK_KEY]);
      }
    } catch (err) {
      this.logger.error(`sweep failed: ${err}`);
    } finally {
      client.release();
    }
  }

  private async doSweep(minUsdc: number): Promise<void> {
    const signer = getFeeCollectionSigner();

    let balanceStroops: bigint;
    try {
      const usdc = await getUsdcClient(signer.address);
      const tx = await withRetry(() => usdc.balance({ id: signer.address }), { retries: 1, timeoutMs: 8_000 });
      balanceStroops = tx.result;
    } catch (err) {
      clientPromise = null;
      this.logger.error(`could not read fee-collection USDC balance: ${err}`);
      return;
    }

    const minStroops = BigInt(Math.round(minUsdc * STROOPS_PER_UNIT));
    const sweepStroops = balanceStroops - minStroops;
    if (sweepStroops <= 0n) {
      return;
    }
    const sweepUsdc = Number(sweepStroops) / STROOPS_PER_UNIT;

    try {
      await this.spendGuard.checkAndRecordSpend(sweepUsdc, 'fee-sweep', TREASURY_CONTRACT_ID);
    } catch (err) {
      if (err instanceof FacilitatorHalted || err instanceof FacilitatorSpendCapExceeded) {
        this.logger.warn(`sweep blocked: ${err.message}`);
        return;
      }
      throw err;
    }

    const result = await this.submitTransfer(signer.address, sweepStroops);
    if (!result.success) {
      this.logger.error(`sweep transfer failed: ${result.errorReason}`);
      return;
    }
    this.logger.log(
      `swept ${sweepUsdc.toFixed(7)} USDC from ${signer.address} to treasury ${TREASURY_CONTRACT_ID}: ${result.transaction}`,
    );
  }

  // Mirrors FacilitatorSweepService's own submitTransfer exactly (same
  // simulate-then-prepare-with-real-sorobanData-then-sign-then-submit
  // shape) -- duplicated rather than shared, consistent with that file's
  // own reasoning for why it duplicates channel.service.ts's
  // submitFacilitatorCall rather than sharing a generic abstraction across
  // two call sites.
  private async submitTransfer(
    fromAddress: string,
    amountStroops: bigint,
  ): Promise<{ success: boolean; transaction?: string; errorReason?: string }> {
    const server = new rpc.Server(RPC_URL);
    const signer = getFeeCollectionSigner();
    const contract = new Contract(USDC_SAC_ID);
    const args = [
      new Address(fromAddress).toScVal(),
      new Address(TREASURY_CONTRACT_ID).toScVal(),
      nativeToScVal(amountStroops, { type: 'i128' }),
    ];

    let sentHash: string;
    try {
      const account = await server.getAccount(signer.address);
      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
        .setTimeout(60)
        .addOperation(contract.call('transfer', ...args))
        .build();

      // server.prepareTransaction() simulates AND assembles in one step --
      // critically, this attaches the SorobanAuthorizationEntry list the
      // simulation computed, not just the resource footprint
      // (sim.transactionData). transfer() calls from.require_auth(): a
      // manual sim.transactionData.build() + rebuild-the-operation approach
      // (the pattern channel.service.ts's submitFacilitatorCall uses)
      // silently drops that auth list, since contract.call(...) alone has
      // no way to know what auth simulation decided was necessary --
      // confirmed for real: an earlier version of this exact function
      // submitted successfully (PENDING) but then trapped on execution
      // with "Unauthorized function call for address <this signer>". That
      // pattern happens to work for channel.service.ts's own two call
      // sites (checkpoint/finalize_close) only because neither of those
      // contract functions calls require_auth() at all -- not because the
      // pattern is generally correct.
      let prepared;
      try {
        prepared = await server.prepareTransaction(tx);
      } catch (err) {
        this.logger.error(`sweep simulation/preparation failed: ${err}`);
        return { success: false, errorReason: 'sweep_simulation_failed' };
      }

      const { signedTxXdr, error: signError } = await signer.signTransaction(prepared.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });
      if (signError || !signedTxXdr) {
        return { success: false, errorReason: 'sweep_signing_failed' };
      }

      const txToSubmit = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
      const sendResult = await server.sendTransaction(txToSubmit);
      if (sendResult.status !== 'PENDING') {
        return { success: false, errorReason: 'sweep_submission_failed' };
      }
      sentHash = sendResult.hash;
    } catch (err) {
      this.logger.error(`sweep transfer failed: ${err}`);
      return { success: false, errorReason: 'sweep_failed' };
    }

    return this.pollForTransaction(server, sentHash);
  }

  private async pollForTransaction(
    server: rpc.Server,
    txHash: string,
    maxAttempts = 15,
    delayMs = 1000,
  ): Promise<{ success: boolean; transaction: string; errorReason?: string }> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await server.getTransaction(txHash);
        if (result.status === 'SUCCESS') {
          return { success: true, transaction: txHash };
        }
        if (result.status === 'FAILED') {
          return { success: false, transaction: txHash, errorReason: 'transaction_failed' };
        }
      } catch {
        // NOT_FOUND while still pending -- expected, keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return { success: false, transaction: txHash, errorReason: 'transaction_timeout' };
  }
}
