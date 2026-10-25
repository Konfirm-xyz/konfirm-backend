import { Injectable } from '@nestjs/common';
import { Contract, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative, rpc } from '@stellar/stellar-sdk';
import { pool } from '../db/pool';
import { NETWORK_PASSPHRASE, RPC_URL, TREASURY_CONTRACT_ID, DEPLOYER_ADDRESS } from '../common/stellar-network';

export interface SettlementRow {
  onchain_settlement_id: string;
  merchant_address: string;
  amount: string;
  approvals_count: number;
  status: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class AdminTreasurySettlementsService {
  // get_settlement(settlement_id) is the contract's only read on a
  // settlement -- there's no "list all" primitive, which is exactly why
  // this service exists: it's the only way the admin UI finds out which
  // settlement ids exist, by being told one (propose/approve/execute all
  // happen from a connected signer's wallet directly against the chain --
  // see docs/PRD.md M2 -- and the UI calls registerOrResync() right after).
  //
  // Simulation-only call, same convenience-source-account reasoning
  // onchain-compliance.ts and channel.service.ts's getChannelInfoOnChain
  // already document: any funded account works, this one just reuses the
  // already-funded deployer identity rather than minting a throwaway.
  private async readOnChain(onchainSettlementId: bigint): Promise<{
    merchant: string;
    amount: bigint;
    approvalsCount: number;
    status: string;
  }> {
    const server = new rpc.Server(RPC_URL);
    const contract = new Contract(TREASURY_CONTRACT_ID);
    const account = await server.getAccount(DEPLOYER_ADDRESS);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .setTimeout(30)
      .addOperation(contract.call('get_settlement', nativeToScVal(onchainSettlementId, { type: 'u64' })))
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
      throw new Error(`get_settlement simulation failed for settlement ${onchainSettlementId} (likely NotFound)`);
    }
    const settlement = scValToNative(sim.result.retval) as {
      merchant: string;
      amount: bigint;
      approvals: string[];
      status: string[] | string;
    };
    const status = Array.isArray(settlement.status) ? settlement.status[0] : settlement.status;
    return { merchant: settlement.merchant, amount: settlement.amount, approvalsCount: settlement.approvals.length, status };
  }

  // Always re-reads the real on-chain record first -- never trusts a
  // caller's claim of a settlement's amount/merchant/status. Called by the
  // admin UI right after a connected wallet submits propose/approve/
  // execute, so the mirror table reflects what actually landed, not what
  // the UI optimistically assumed would.
  async registerOrResync(onchainSettlementId: bigint): Promise<SettlementRow> {
    const { merchant, amount, approvalsCount, status } = await this.readOnChain(onchainSettlementId);
    const { rows } = await pool.query<SettlementRow>(
      `INSERT INTO treasury_settlements (onchain_settlement_id, merchant_address, amount, approvals_count, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (onchain_settlement_id) DO UPDATE
         SET merchant_address = $2, amount = $3, approvals_count = $4, status = $5, updated_at = NOW()
       RETURNING onchain_settlement_id::text, merchant_address, amount::text, approvals_count, status, created_at, updated_at`,
      [onchainSettlementId.toString(), merchant, amount.toString(), approvalsCount, status],
    );
    return rows[0];
  }

  async list(): Promise<SettlementRow[]> {
    const { rows } = await pool.query<SettlementRow>(
      `SELECT onchain_settlement_id::text, merchant_address, amount::text, approvals_count, status, created_at, updated_at
       FROM treasury_settlements
       ORDER BY (status = 'Pending') DESC, onchain_settlement_id DESC`,
    );
    return rows;
  }

  async get(onchainSettlementId: bigint): Promise<SettlementRow | null> {
    const { rows } = await pool.query<SettlementRow>(
      `SELECT onchain_settlement_id::text, merchant_address, amount::text, approvals_count, status, created_at, updated_at
       FROM treasury_settlements WHERE onchain_settlement_id = $1`,
      [onchainSettlementId.toString()],
    );
    return rows[0] ?? null;
  }
}
