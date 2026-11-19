import { Injectable } from '@nestjs/common';
import { Horizon, rpc } from '@stellar/stellar-sdk';
import { withRetry } from '../common/retry';
import { HORIZON_URL, NETWORK_PASSPHRASE, RPC_URL } from '../common/stellar-network';
import { FACILITATOR_ADDRESS, COMPLIANCE_CONTRACT_ID, PAYMENT_CONTRACT_ID, TREASURY_CONTRACT_ID, CHANNEL_CONTRACT_ID } from '../common/stellar-network';
import { checkComplianceCanary } from '../common/onchain-compliance';
import { resolveAsset } from '../common/asset';
import { ChannelService } from '../x402/channel.service';


// Same facilitator identity used everywhere else (facilitator-signer.ts,
// onchain-compliance.ts's simulation source, konfirm-contracts' deployer)
// and the four contract addresses from konfirm-contracts/README.md's
// "Deployed addresses (Testnet)" table — this page has no state of its
// own to be wrong about, it just asks the chain live every request.

const CONTRACTS = [
  { name: 'Compliance', id: COMPLIANCE_CONTRACT_ID },
  { name: 'Payment', id: PAYMENT_CONTRACT_ID },
  // Redeployed when execute_settlement was fixed to actually transfer funds
  // (konfirm-contracts d55d546/7a4b664) — the old address here was stale,
  // pointing at the pre-fix instance.
  { name: 'Treasury', id: TREASURY_CONTRACT_ID },
  { name: 'Channel', id: CHANNEL_CONTRACT_ID },
];

@Injectable()
export class AdminBlockchainService {
  private horizon = new Horizon.Server(HORIZON_URL);
  private rpcServer = new rpc.Server(RPC_URL);

  constructor(private readonly channel: ChannelService) {}

  // backend#191: the channel contract only accepts open_channel for tokens
  // allowlisted via set_token_allowed, and nothing in this backend ever
  // called it. This is the documented, admin-driven way to do it after a
  // fresh deploy + initialize. The token list is exactly what the backend's
  // own config (stellar-network.ts, via resolveAsset) expects to accept —
  // USDC, EURC, XLM — so it can't drift from what open_channel will be
  // asked to use. Each token is submitted separately: one failure doesn't
  // hide the others' results.
  async allowlistChannelTokens(): Promise<{
    channelContractId: string;
    results: Array<{ currency: string; tokenAddress: string; success: boolean; transaction?: string; errorReason?: string }>;
  }> {
    const results: Array<{
      currency: string;
      tokenAddress: string;
      success: boolean;
      transaction?: string;
      errorReason?: string;
    }> = [];
    for (const currency of ['USDC', 'EURC', 'XLM']) {
      const tokenAddress = resolveAsset(currency).contractId(NETWORK_PASSPHRASE);
      const result = await this.channel.setTokenAllowed(tokenAddress, true);
      results.push({ currency, tokenAddress, ...result });
    }
    return { channelContractId: CHANNEL_CONTRACT_ID, results };
  }

  async status() {
    const [facilitatorResult, rpcResult, complianceCanary] = await Promise.allSettled([
      withRetry(() => this.horizon.loadAccount(FACILITATOR_ADDRESS), { retries: 1, timeoutMs: 8_000 }),
      this.pingRpc(),
      checkComplianceCanary(),
    ]);

    return {
      network: 'testnet',
      facilitator: {
        address: FACILITATOR_ADDRESS,
        reachable: facilitatorResult.status === 'fulfilled',
        balances:
          facilitatorResult.status === 'fulfilled'
            ? facilitatorResult.value.balances.map((b) => ({
                asset: b.asset_type === 'native' ? 'XLM' : (b as { asset_code?: string }).asset_code ?? b.asset_type,
                balance: b.balance,
              }))
            : [],
      },
      rpc: rpcResult.status === 'fulfilled' ? rpcResult.value : { reachable: false, latencyMs: null, latestLedger: null },
      contracts: CONTRACTS,
      // backend#210: detects a compliance contract that's silently
      // uninitialized or misconfigured — see onchain-compliance.ts's
      // checkComplianceCanary(). `ok: null` means no canary address is
      // configured yet for this environment, not that it passed.
      complianceCanary:
        complianceCanary.status === 'fulfilled' ? complianceCanary.value : { configured: true, ok: false },
    };
  }

  private async pingRpc(): Promise<{ reachable: true; latencyMs: number; latestLedger: number }> {
    const start = Date.now();
    const ledger = await withRetry(() => this.rpcServer.getLatestLedger(), { retries: 1, timeoutMs: 8_000 });
    return { reachable: true, latencyMs: Date.now() - start, latestLedger: ledger.sequence };
  }
}
