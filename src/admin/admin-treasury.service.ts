/// <reference path="../common/stellar-sdk-contract.d.ts" />
import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@stellar/stellar-sdk/contract';
import type { AssembledTransaction, MethodOptions } from '@stellar/stellar-sdk/contract';
import { Asset, Horizon, Networks, StrKey } from '@stellar/stellar-sdk';
import { withRetry } from '../common/retry';
import { hasTrustline } from '../common/asset';
import { HORIZON_URL, NETWORK_PASSPHRASE, RPC_URL } from '../common/stellar-network';
import { USDC_ISSUER, USDC_SAC_ID, TREASURY_CONTRACT_ID, TREASURY_SIGNERS, DEPLOYER_ADDRESS } from '../common/stellar-network';

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
  private readonly logger = new Logger(AdminTreasuryService.name);
  private readonly horizon = new Horizon.Server(HORIZON_URL);

  // The treasury contract's own account id, derived from its contract id
  // (Stellar's contract-address derivation: the contract's 32-byte hash
  // under the "contract" strkey version byte). This is the account whose
  // USDC trustline a classic Payment must target to fund the contract --
  // the SAC balance the contract spends from is that account's balance.
  private treasuryAccountId(): string {
    const contractHash = StrKey.decodeContract(TREASURY_CONTRACT_ID);
    return StrKey.encodeEd25519PublicKey(contractHash);
  }

  // Read-only: does the treasury contract account already hold a USDC
  // trustline? A contract account can't sign a ChangeTrust itself, so the
  // trustline has to be sponsored/created out of band (see
  // scripts/fund-testnet-treasury.mjs). Surfacing it here is what turns
  // "execute traps with 0 balance" into an actionable admin signal.
  private async usdcTrustline(): Promise<boolean | null> {
    try {
      const account = await withRetry(() => this.horizon.loadAccount(this.treasuryAccountId()), {
        retries: 1,
        timeoutMs: 8_000,
      });
      const balances = account.balances as Array<{ asset_code?: string; asset_issuer?: string }>;
      return hasTrustline(balances, new Asset('USDC', USDC_ISSUER));
    } catch {
      return null;
    }
  }

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
      this.logger.warn(`could not read treasury USDC balance: ${(err as Error)?.message ?? err}`);
    }

    return {
      contract_id: TREASURY_CONTRACT_ID,
      contract_account_id: this.treasuryAccountId(),
      signers: TREASURY_SIGNERS,
      threshold: '2-of-3',
      usdc_balance: usdcBalance,
      usdc_trustline: await this.usdcTrustline(),
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
