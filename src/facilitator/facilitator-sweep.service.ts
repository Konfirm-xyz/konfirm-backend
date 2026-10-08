/// <reference path="../common/stellar-sdk-contract.d.ts" />
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk';
import { Client } from '@stellar/stellar-sdk/contract';
import type { AssembledTransaction, MethodOptions } from '@stellar/stellar-sdk/contract';
import { pool } from '../db/pool';
import { withRetry } from '../common/retry';
import { getFacilitatorSigner, withFacilitatorSubmissionLock } from '../common/facilitator-signer';
import { FacilitatorSpendGuardService, FacilitatorHalted, FacilitatorSpendCapExceeded } from './facilitator-spend-guard.service';
import { NETWORK_PASSPHRASE, RPC_URL } from '../common/stellar-network';
import { USDC_SAC_ID, TREASURY_CONTRACT_ID } from '../common/stellar-network';

// USDC's SAC (SEP-41 token contract) on testnet -- same address
// admin-treasury.service.ts and @x402/stellar's own ExactStellarScheme use.
// The fixed, fund-custodying treasury instance -- same address
// admin-treasury.service.ts reads, from konfirm-contracts/README.md's
// "Deployed addresses (Testnet)" table.
const STROOPS_PER_UNIT = 10_000_000;
// Arbitrary but stable pg_advisory_lock key -- namespaced away from
// ChannelKeeperService's own KEEPER_LOCK_KEY (402_001).
const SWEEP_LOCK_KEY = 402_002;

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
 * Sweeps the facilitator's own accumulated USDC balance above a configured
 * operating minimum into the (multisig-gated) treasury contract. This is
 * the one operation in the facilitator's whole call surface that actually
 * moves the facilitator's *own* money -- x402 settle and channel
 * open/checkpoint/close all relay value between a payer and payee whose
 * destinations are fixed by their own independently-signed inputs, so a
 * compromised-but-still-legitimate facilitator process can't redirect
 * those. It CAN redirect this sweep, which is exactly why
 * FacilitatorSpendGuardService is wired in here and nowhere else.
 *
 * In-process @Cron(), same reasoning as ChannelKeeperService/
 * ReferralRewardsService: shares the same Postgres pool and Soroban signer
 * the api service already owns, and a standalone service would just
 * reproduce the backup-cron shared-railway.json class of bug this project
 * already hit once, for no benefit here.
 */
@Injectable()
export class FacilitatorSweepService {
  private readonly logger = new Logger(FacilitatorSweepService.name);

  constructor(private readonly spendGuard: FacilitatorSpendGuardService) {}

  @Cron('*/30 * * * *')
  async sweep(): Promise<void> {
    // Unset means "not configured", not "sweep everything" -- leaving an
    // in-flight facilitator's hot-wallet balance undefined is the wrong
    // failure mode (it still needs USDC/XLM for the next settlement);
    // skipping the sweep is the safe default until an operator explicitly
    // sets a minimum to preserve.
    const minUsdcRaw = process.env.FACILITATOR_SWEEP_MIN_USDC_BALANCE;
    if (minUsdcRaw === undefined) {
      this.logger.debug('FACILITATOR_SWEEP_MIN_USDC_BALANCE not set -- skipping sweep');
      return;
    }

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
        SWEEP_LOCK_KEY,
      ]);
      if (!rows[0].locked) {
        // Another sweep -- or another api replica -- is already running.
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
    const signer = await getFacilitatorSigner();

    let balanceStroops: bigint;
    try {
      const usdc = await getUsdcClient(signer.address);
      const tx = await withRetry(() => usdc.balance({ id: signer.address }), { retries: 1, timeoutMs: 8_000 });
      balanceStroops = tx.result;
    } catch (err) {
      clientPromise = null;
      this.logger.error(`could not read facilitator USDC balance: ${err}`);
      return;
    }

    const minStroops = BigInt(Math.round(minUsdc * STROOPS_PER_UNIT));
    const sweepStroops = balanceStroops - minStroops;
    if (sweepStroops <= 0n) {
      return;
    }
    const sweepUsdc = Number(sweepStroops) / STROOPS_PER_UNIT;

    // Recorded (and, on a cap breach, halted) BEFORE submission -- see
    // FacilitatorSpendGuardService's own doc comment for why this fails
    // closed rather than reconciling after the fact.
    try {
      await this.spendGuard.checkAndRecordSpend(sweepUsdc, 'sweep', TREASURY_CONTRACT_ID);
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

  // Mirrors ChannelService's private submitFacilitatorCall (same
  // simulate-then-prepare-with-real-sorobanData-then-sign-then-submit
  // shape, same withFacilitatorSubmissionLock use to avoid a sequence-
  // number race against any other facilitator submission in flight) --
  // duplicated rather than shared because it targets a different contract
  // (the USDC SAC's own `transfer`, not the channel contract) and this
  // project already duplicates this exact shape once (channel.service.ts)
  // rather than building a generic abstraction for two call sites.
  private async submitTransfer(
    fromAddress: string,
    amountStroops: bigint,
  ): Promise<{ success: boolean; transaction?: string; errorReason?: string }> {
    const server = new rpc.Server(RPC_URL);
    const signer = await getFacilitatorSigner();
    const contract = new Contract(USDC_SAC_ID);
    const args = [
      new Address(fromAddress).toScVal(),
      new Address(TREASURY_CONTRACT_ID).toScVal(),
      nativeToScVal(amountStroops, { type: 'i128' }),
    ];

    return withFacilitatorSubmissionLock(async () => {
      let sentHash: string;
      try {
        const account = await server.getAccount(signer.address);
        const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
          .setTimeout(60)
          .addOperation(contract.call('transfer', ...args))
          .build();

        // server.prepareTransaction() simulates AND assembles in one step --
        // critically, this attaches the SorobanAuthorizationEntry list the
        // simulation computed, not just the resource footprint. transfer()
        // calls from.require_auth(): a manual sim.transactionData.build() +
        // rebuild-the-operation approach (what this used to do, mirroring
        // channel.service.ts's submitFacilitatorCall) silently drops that
        // auth list, since contract.call(...) alone has no way to know what
        // auth simulation decided was necessary -- confirmed for real: this
        // exact shape submitted successfully (PENDING) but then trapped on
        // execution with "Unauthorized function call for address <signer>"
        // (found while building and live-testing fee-collection-sweep.
        // service.ts's identical pattern). channel.service.ts's own two call
        // sites (checkpoint/finalize_close) never hit this because neither
        // of those contract functions calls require_auth() at all -- not
        // because that pattern is generally correct.
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
    });
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
