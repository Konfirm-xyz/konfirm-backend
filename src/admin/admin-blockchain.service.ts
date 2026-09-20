import { Injectable } from '@nestjs/common';
import { Horizon, rpc } from '@stellar/stellar-sdk';
import { withRetry } from '../common/retry';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const RPC_URL = 'https://soroban-testnet.stellar.org';

// Same facilitator identity used everywhere else (facilitator-signer.ts,
// onchain-compliance.ts's simulation source, konfirm-contracts' deployer)
// and the four contract addresses from konfirm-contracts/README.md's
// "Deployed addresses (Testnet)" table — this page has no state of its
// own to be wrong about, it just asks the chain live every request.
const FACILITATOR_ADDRESS = 'GAEMG5TVLEIQYCY3XB4EJT742DIE3FQO53RSESSYJQUZIWZOJQIZATJS';

const CONTRACTS = [
  { name: 'Compliance', id: 'CDDVLE2DZQAYFY3Z2Z74TUNNPC4ROUACSBXOB2P64IT75EZFAQXSRSXY' },
  { name: 'Payment', id: 'CCYRA6JT2L4NS5FG4B5TP52JPCGCPYSP7M6LUDUY2QA37V5UBXWJBRHV' },
  // Redeployed when execute_settlement was fixed to actually transfer funds
  // (konfirm-contracts d55d546/7a4b664) — the old address here was stale,
  // pointing at the pre-fix instance.
  { name: 'Treasury', id: 'CD77HPVBGIRYQGXC4JVCEO35X6FKFFJ2C4EZ63EQCOXGR6OL4TVEPZ2T' },
  { name: 'Channel', id: 'CDS2Y4CQMQWFLCG5GHVKX7UIXHYPM6IJDJZTEXSASSHGHLESGLGLNPL6' },
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
