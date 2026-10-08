/// <reference path="../common/stellar-sdk-contract.d.ts" />
import { Injectable } from '@nestjs/common';
import { Client } from '@stellar/stellar-sdk/contract';
import type { AssembledTransaction, MethodOptions } from '@stellar/stellar-sdk/contract';
import { Networks } from '@stellar/stellar-sdk';
import { withRetry } from '../common/retry';
import { NETWORK_PASSPHRASE, RPC_URL } from '../common/stellar-network';
import { USDC_SAC_ID, TREASURY_CONTRACT_ID, TREASURY_SIGNERS, DEPLOYER_ADDRESS } from '../common/stellar-network';

// USDC's SAC (SEP-41 token contract) on testnet — same address
// @x402/stellar's own ExactStellarScheme uses (USDC_TESTNET_ADDRESS).
// From konfirm-contracts/README.md's "Deployed addresses (Testnet)" table.
// Same convenience simulation source as onchain-compliance.ts — a
// read-only `balance` call never signs or pays a fee, it just needs a
// real, funded source account for simulation context.

interface SacTokenContract {
  balance(args: { id: string }, options?: MethodOptions): Promise<AssembledTransaction<bigint>>;
}

let clientPromise: Promise<Client & SacTokenContract> | null = null;
function getUsdcClient(): Promise<Client & SacTokenContract> {
  if (!clientPromise) {
    clientPromise = Client.from<SacTokenContract>({
      contractId: USDC_SAC_ID,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      publicKey: DEPLOYER_ADDRESS,
    });
  }
  return clientPromise;
}

@Injectable()
export class AdminTreasuryService {
  async status() {
    let usdcBalance: string | null = null;
    let reachable = true;
    try {
      const tx = await withRetry(
        async () => {
          const client = await getUsdcClient();
          return client.balance({ id: TREASURY_CONTRACT_ID });
        },
        { retries: 1, timeoutMs: 8_000 },
      );
      usdcBalance = (Number(tx.result) / 10_000_000).toFixed(7);
    } catch (err) {
      reachable = false;
      clientPromise = null;
      // eslint-disable-next-line no-console
      console.warn('[admin] could not read treasury USDC balance', err);
    }

    return {
      contract_id: TREASURY_CONTRACT_ID,
      signers: TREASURY_SIGNERS,
      threshold: '2-of-3',
      usdc_balance: usdcBalance,
      reachable,
      // Checkout's USDC-denominated fee revenue reaches this contract via
      // FeeCollectionSweepService, not a direct call at checkout time — a
      // Soroban contract invocation must be the sole operation in its
      // transaction, so the fee leg (payments.service.ts's prepareTx) can
      // only ever be a plain classic Payment into PLATFORM_FEE_ADDRESS,
      // which this sweep then moves into custody periodically. XLM/EURC
      // fee revenue is NOT covered — this instance was initialized with a
      // single USDC token and cannot custody other assets.
      wired_into_checkout: true,
    };
  }
}
