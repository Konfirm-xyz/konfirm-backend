import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Address,
  BASE_FEE,
  Contract,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
} from '@stellar/stellar-sdk';
import { pool } from '../db/pool';
import { toStroops } from '../common/money-rules';
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

// What a build endpoint hands back to the admin UI: enough to sign in
// Freighter (unsigned_xdr + network_passphrase) and enough to redeem that
// signature later (build_token, opaque to the caller) without ever
// re-trusting a claimed tx_hash from the client.
export interface BuiltTx {
  build_token: string;
  unsigned_xdr: string;
  network_passphrase: string;
  tx_hash: string;
}

type BuildKind = 'propose' | 'approve' | 'execute';

// Mirrors fees.service.ts's SETTLEMENT_TTL_SECONDS -- long enough for an
// admin to actually open Freighter and sign, short enough that a stale
// build can't be replayed much later against a treasury state that moved
// on.
const BUILD_TTL_SECONDS = 15 * 60;

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

  // ---------------------------------------------------------------------
  // Build-unsigned-tx / submit-signed-tx, mirroring fees.service.ts's
  // createSettlement()/submitSigned() exactly: the backend builds an
  // unsigned transaction server-side, remembers the tx hash it built,
  // hands the admin { unsigned_xdr, network_passphrase } to sign in
  // Freighter, and later refuses to submit anything whose hash doesn't
  // match what it actually built -- so a tampered "signed" transaction
  // can never be slipped through under a signer's real signature.
  //
  // Unlike fees.service.ts, the signer here is never the merchant's own
  // session -- it's whichever treasury signer (deployer/signer2/signer3)
  // the connected admin is acting as in Freighter, so every build takes
  // that signer's address explicitly rather than reading it off a session.
  // ---------------------------------------------------------------------

  async buildProposeTx(proposerAddress: string, merchantAddress: string, amount: string): Promise<BuiltTx> {
    const amountStroops = toStroops(amount);
    if (amountStroops <= 0n) throw new BadRequestException('amount must be greater than zero');
    const args = [
      new Address(proposerAddress).toScVal(),
      new Address(merchantAddress).toScVal(),
      nativeToScVal(amountStroops, { type: 'i128' }),
    ];
    const built = await this.buildSignerCall(proposerAddress, 'propose_settlement', args);
    return this.stashBuild('propose', proposerAddress, null, built);
  }

  async buildApproveTx(signerAddress: string, settlementId: bigint): Promise<BuiltTx> {
    const args = [new Address(signerAddress).toScVal(), nativeToScVal(settlementId, { type: 'u64' })];
    const built = await this.buildSignerCall(signerAddress, 'approve_settlement', args);
    return this.stashBuild('approve', signerAddress, settlementId, built);
  }

  async buildExecuteTx(callerAddress: string, settlementId: bigint): Promise<BuiltTx> {
    const args = [new Address(callerAddress).toScVal(), nativeToScVal(settlementId, { type: 'u64' })];
    const built = await this.buildSignerCall(callerAddress, 'execute_settlement', args);
    return this.stashBuild('execute', callerAddress, settlementId, built);
  }

  // The signer's own account is the transaction source. That's what lets
  // Soroban's source-account authorization shortcut satisfy
  // require_signer's require_auth() once the signer signs the envelope in
  // Freighter -- same reasoning channel.service.ts's initiateCloseAsDelegate
  // documents for the facilitator's own delegated-close call. That
  // shortcut still needs one SorobanAuthorizationEntry of type
  // sorobanCredentialsSourceAccount attached to the operation -- an empty
  // auth vector traps on require_auth() exactly like a missing signature
  // would (confirmed live while building this: a first draft that rebuilt
  // the operation via plain `contract.call(fn, ...args)` without copying
  // simulation's returned auth entries submitted successfully but the
  // transaction itself failed on-chain with invoke_host_function:
  // "trapped" -- not the expected 0-balance trap, an auth trap, since the
  // resubmitted operation's auth vector was empty).
  //
  // rpc.assembleTransaction(simTx, sim) is the SDK's own helper for
  // exactly this: it clones from the already-built, already-sequenced
  // simTx and copies across both the simulated Soroban footprint data and
  // the simulated auth entries (including the source-account one). Builds
  // off simTx's fixed sequence number rather than a live Account object,
  // so there's no risk of a second .build() call silently consuming a
  // sequence number the final transaction still needs.
  private async buildSignerCall(
    sourceAddress: string,
    functionName: string,
    args: ReturnType<typeof nativeToScVal>[],
  ): Promise<{ unsignedXdr: string; txHash: string }> {
    const server = new rpc.Server(RPC_URL);
    const contract = new Contract(TREASURY_CONTRACT_ID);
    const account = await server.getAccount(sourceAddress);
    const simTx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .setTimeout(60)
      .addOperation(contract.call(functionName, ...args))
      .build();
    const sim = await server.simulateTransaction(simTx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      const detail = rpc.Api.isSimulationError(sim) ? sim.error : JSON.stringify(sim);
      throw new BadRequestException(`${functionName} simulation failed: ${detail}`);
    }
    const tx = rpc.assembleTransaction(simTx, sim).build();
    return { unsignedXdr: tx.toXDR(), txHash: Buffer.from(tx.hash()).toString('hex') };
  }

  private async stashBuild(
    kind: BuildKind,
    signerAddress: string,
    onchainSettlementId: bigint | null,
    built: { unsignedXdr: string; txHash: string },
  ): Promise<BuiltTx> {
    const expiresAt = new Date(Date.now() + BUILD_TTL_SECONDS * 1000);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO treasury_settlement_builds (kind, signer_address, onchain_settlement_id, tx_hash, unsigned_xdr, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [kind, signerAddress, onchainSettlementId?.toString() ?? null, built.txHash, built.unsignedXdr, expiresAt],
    );
    return {
      build_token: rows[0].id,
      unsigned_xdr: built.unsignedXdr,
      network_passphrase: NETWORK_PASSPHRASE,
      tx_hash: built.txHash,
    };
  }

  // Submits what the signer signed in Freighter. The signed transaction's
  // hash must equal the hash recorded when it was built -- identical
  // discipline to fees.service.ts's submitSigned(), applied here to a
  // signer's own treasury call instead of a merchant's fee payment.
  // Always re-syncs the mirror row from chain afterward (registerOrResync),
  // never from anything the client claims.
  async submitSigned(signedXdr: string, buildToken: string): Promise<SettlementRow & { tx_hash: string }> {
    const { rows } = await pool.query(
      `SELECT id, kind, onchain_settlement_id, tx_hash, status, expires_at
       FROM treasury_settlement_builds WHERE id = $1`,
      [buildToken],
    );
    const build = rows[0] as
      | { id: string; kind: BuildKind; onchain_settlement_id: string | null; tx_hash: string; status: string; expires_at: string }
      | undefined;
    if (!build) throw new NotFoundException('build not found -- call the matching build endpoint first');
    if (build.status !== 'pending') throw new ConflictException(`this build is already ${build.status}`);
    if (new Date(build.expires_at) <= new Date()) throw new ConflictException('this build expired -- build again');

    let tx: Transaction;
    try {
      tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE) as Transaction;
    } catch {
      throw new BadRequestException('malformed signed transaction');
    }
    // The exact check that stops a signer's wallet from submitting a
    // different, tampered transaction under cover of "signed" -- adding a
    // signature never changes a transaction's hash.
    if (Buffer.from(tx.hash()).toString('hex') !== build.tx_hash) {
      throw new BadRequestException('the signed transaction is not the one Konfirm built for this request');
    }

    const server = new rpc.Server(RPC_URL);
    const sendResult = await server.sendTransaction(tx);
    if (sendResult.status !== 'PENDING') {
      await this.markBuildFailed(buildToken, `send:${sendResult.status}`);
      throw new BadRequestException({ message: 'the network rejected the transaction', status: sendResult.status });
    }

    const confirmed = await this.pollForTransaction(server, sendResult.hash);
    if (!confirmed.success) {
      await this.markBuildFailed(buildToken, confirmed.timedOut ? 'confirmation_timeout' : 'transaction_failed');
      throw new BadRequestException({
        message: confirmed.timedOut ? 'confirmation timed out -- it may still land' : 'the transaction failed on-chain',
        tx_hash: build.tx_hash,
      });
    }

    await pool.query(`UPDATE treasury_settlement_builds SET status = 'submitted', submitted_at = NOW() WHERE id = $1`, [buildToken]);

    // propose_settlement assigns its own id, only known from the confirmed
    // return value; approve/execute already knew theirs at build time.
    const onchainSettlementId =
      build.onchain_settlement_id !== null ? BigInt(build.onchain_settlement_id) : (confirmed.returnValue as bigint);
    const row = await this.registerOrResync(onchainSettlementId);
    return { ...row, tx_hash: build.tx_hash };
  }

  private async markBuildFailed(buildToken: string, detail: string): Promise<void> {
    await pool.query(
      `UPDATE treasury_settlement_builds SET status = 'failed', submission_error = $2 WHERE id = $1 AND status = 'pending'`,
      [buildToken, detail],
    );
  }

  // Mirrors channel.service.ts's pollForTransaction exactly -- NOT_FOUND
  // while pending is expected and keeps polling; SUCCESS/FAILED are
  // terminal; running out of attempts is reported as a timeout, not a
  // definite on-chain rejection, since the transaction may still land.
  private async pollForTransaction(
    server: rpc.Server,
    txHash: string,
    maxAttempts = 20,
    delayMs = 1500,
  ): Promise<{ success: boolean; timedOut?: boolean; returnValue?: unknown }> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await server.getTransaction(txHash);
        if (result.status === 'SUCCESS') {
          return { success: true, returnValue: result.returnValue ? scValToNative(result.returnValue) : undefined };
        }
        if (result.status === 'FAILED') {
          return { success: false };
        }
      } catch {
        // NOT_FOUND while still pending -- expected, keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return { success: false, timedOut: true };
  }
}
