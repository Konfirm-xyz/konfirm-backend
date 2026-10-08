import { Injectable } from '@nestjs/common';
import { Horizon, rpc } from '@stellar/stellar-sdk';
import { withRetry } from '../common/retry';
import { HORIZON_URL, RPC_URL } from '../common/stellar-network';
import { FACILITATOR_ADDRESS, COMPLIANCE_CONTRACT_ID, PAYMENT_CONTRACT_ID, TREASURY_CONTRACT_ID, CHANNEL_CONTRACT_ID } from '../common/stellar-network';


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

  async status() {
    const [facilitatorResult, rpcResult] = await Promise.allSettled([
      withRetry(() => this.horizon.loadAccount(FACILITATOR_ADDRESS), { retries: 1, timeoutMs: 8_000 }),
      this.pingRpc(),
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
    };
  }

  private async pingRpc(): Promise<{ reachable: true; latencyMs: number; latestLedger: number }> {
    const start = Date.now();
    const ledger = await withRetry(() => this.rpcServer.getLatestLedger(), { retries: 1, timeoutMs: 8_000 });
    return { reachable: true, latencyMs: Date.now() - start, latestLedger: ledger.sequence };
  }
}
