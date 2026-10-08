import { Injectable, Logger } from '@nestjs/common';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  Transaction,
  TransactionBuilder,
  Operation,
  nativeToScVal,
  scValToNative,
  rpc,
} from '@stellar/stellar-sdk';
import { pool } from '../db/pool';
import { verifyClaimSignature } from '../common/channel-claim';
import { getFacilitatorSigner, withFacilitatorSubmissionLock } from '../common/facilitator-signer';
import { isAllowedOnChain } from '../common/onchain-compliance';
import { NETWORK_PASSPHRASE, RPC_URL } from '../common/stellar-network';
import { CHANNEL_CONTRACT_ID } from '../common/stellar-network';

export interface FacilitatorCallResult {
  success: boolean;
  transaction?: string;
  returnValue?: unknown;
  errorReason?: string;
}

export interface ClaimResult {
  accepted: boolean;
  reason?: string;
}

export interface OpenChannelResult {
  success: boolean;
  onchainChannelId?: string;
  transaction?: string;
  errorReason?: string;
}

export interface CloseChannelResult {
  success: boolean;
  transaction?: string;
  errorReason?: string;
}


@Injectable()
export class ChannelService {
  private readonly logger = new Logger(ChannelService.name);

  // The fast path: hit once per request instead of /x402/settle once a
  // channel is open. No RPC call anywhere in here — the whole point of
  // netting is that this costs a Postgres round-trip and a local ed25519
  // verification, not a Soroban simulation + submission. The channel's
  // actual on-chain checkpoint only happens later, via the keeper.
  async claim(params: {
    onchainChannelId: bigint;
    cumulativeAmount: bigint;
    nonce: bigint;
    signature: Buffer;
  }): Promise<ClaimResult> {
    const { rows } = await pool.query(
      `SELECT payer_pubkey, deposited, pending_amount, pending_nonce, status
       FROM x402_channels WHERE onchain_channel_id = $1`,
      [params.onchainChannelId.toString()],
    );
    if (rows.length === 0) {
      return { accepted: false, reason: 'channel_not_found' };
    }
    const row = rows[0] as {
      payer_pubkey: string;
      deposited: string;
      pending_amount: string;
      pending_nonce: string;
      status: string;
    };

    // Once a channel is winding down, the off-chain fast path stops
    // extending new credit — this endpoint is for accumulating claims
    // during normal operation, not for negotiating a dispute (that's the
    // on-chain checkpoint() call itself, driven by the keeper).
    if (row.status !== 'open') {
      return { accepted: false, reason: 'channel_not_open' };
    }

    const pendingAmount = BigInt(row.pending_amount);
    const pendingNonce = BigInt(row.pending_nonce);
    const deposited = BigInt(row.deposited);

    // Same monotonicity + capacity checks the contract itself enforces in
    // checkpoint() — mirrored here so a bad claim never even gets stored,
    // not just eventually rejected on-chain.
    if (params.nonce <= pendingNonce || params.cumulativeAmount <= pendingAmount) {
      return { accepted: false, reason: 'stale_claim' };
    }
    if (params.cumulativeAmount > deposited) {
      return { accepted: false, reason: 'exceeds_deposit' };
    }

    const valid = verifyClaimSignature({
      channelId: params.onchainChannelId,
      nonce: params.nonce,
      cumulativeAmount: params.cumulativeAmount,
      payerPubkey: Buffer.from(row.payer_pubkey, 'hex'),
      signature: params.signature,
    });
    if (!valid) {
      this.logger.warn(`rejected claim with invalid signature for channel ${params.onchainChannelId}`);
      return { accepted: false, reason: 'invalid_signature' };
    }

    // WHERE pending_nonce < $3 makes this a real compare-and-swap, not a
    // blind write — the SELECT above and this UPDATE are two separate
    // round-trips, so two concurrent claims can both read the same
    // starting state, both pass the monotonicity check in JS above, and
    // then race each other's UPDATE. Without the guard, whichever write
    // lands last always wins regardless of which claim was actually
    // newer — confirmed for real: 30 concurrent valid claims (nonces
    // 3-32) against the live testnet channel left the row at nonce=28
    // instead of the expected nonce=32, silently losing an
    // already-accepted higher claim. The guard makes a losing claim's
    // write a no-op (rowCount 0) instead of a stale overwrite; the row
    // count is checked and reported so the caller learns it lost the
    // race rather than being told a claim was durably accepted when it
    // wasn't.
    const { rowCount } = await pool.query(
      `UPDATE x402_channels
       SET pending_amount = $2, pending_nonce = $3, pending_signature = $4, last_activity_at = NOW(), updated_at = NOW()
       WHERE onchain_channel_id = $1 AND pending_nonce < $3`,
      [params.onchainChannelId.toString(), params.cumulativeAmount.toString(), params.nonce.toString(), params.signature.toString('hex')],
    );
    if (rowCount === 0) {
      return { accepted: false, reason: 'stale_claim' };
    }

    return { accepted: true };
  }

  // Same client-signs-facilitator-submits pattern @x402/stellar's own
  // ExactStellarScheme.settle() uses for transfer() — confirmed by reading
  // its actual implementation rather than assumed: the payer builds and
  // signs a transaction invoking open_channel locally (their own auth
  // entry embedded, no submission), sends the resulting XDR here. The
  // facilitator parses it, validates it's genuinely open_channel targeting
  // this contract (not something else the payer tricked us into signing),
  // runs compliance on the extracted payer address, then rebuilds the
  // transaction with itself as source/fee-payer, signs, and submits.
  async openChannel(params: { transactionXdr: string; resourceUrl?: string }): Promise<OpenChannelResult> {
    const server = new rpc.Server(RPC_URL);
    let transaction: Transaction;
    try {
      transaction = new Transaction(params.transactionXdr, NETWORK_PASSPHRASE);
    } catch {
      return { success: false, errorReason: 'malformed_transaction' };
    }

    if (transaction.operations.length !== 1) {
      return { success: false, errorReason: 'wrong_operation_count' };
    }
    const operation = transaction.operations[0];
    if (operation.type !== 'invokeHostFunction') {
      return { success: false, errorReason: 'wrong_operation_type' };
    }

    const signer = await getFacilitatorSigner();
    // The facilitator must never be the transaction/operation source of a
    // transaction someone else handed us to submit — same safety check
    // ExactStellarScheme applies to the single-shot settle path.
    if ((operation.source ?? transaction.source) === signer.address) {
      return { success: false, errorReason: 'unsafe_tx_source' };
    }

    const func = operation.func;
    if (!func || func.type !== 'hostFunctionTypeInvokeContract') {
      return { success: false, errorReason: 'wrong_operation_type' };
    }
    const invokeArgs = func.invokeContract;
    const contractAddress = Address.fromScAddress(invokeArgs.contractAddress).toString();
    const functionName = invokeArgs.functionName.toString();
    const args = invokeArgs.args;
    if (contractAddress !== CHANNEL_CONTRACT_ID) {
      return { success: false, errorReason: 'wrong_contract' };
    }
    if (functionName !== 'open_channel' || args.length !== 5) {
      return { success: false, errorReason: 'wrong_function' };
    }

    const payerAddress = scValToNative(args[0]) as string;
    const payeeAddress = scValToNative(args[1]) as string;
    const tokenAddress = scValToNative(args[2]) as string;
    const payerPubkey = scValToNative(args[3]) as Buffer;
    const deposit = scValToNative(args[4]) as bigint;

    if (payerAddress === signer.address) {
      return { success: false, errorReason: 'facilitator_is_payer' };
    }

    // Compliance gate, once, at open time — not deferred to settlement.
    // Reuses the exact shared check already protecting checkout and
    // single-shot x402 settlement, not new logic.
    const { rows: blocked } = await pool.query('SELECT 1 FROM blocked_addresses WHERE stellar_address = $1', [payerAddress]);
    if (blocked.length > 0 || !(await isAllowedOnChain(payerAddress))) {
      return { success: false, errorReason: 'compliance_blocked' };
    }

    let simResponse: rpc.Api.SimulateTransactionResponse;
    try {
      simResponse = await server.simulateTransaction(transaction);
    } catch (err) {
      this.logger.error(`open_channel simulation failed: ${err}`);
      return { success: false, errorReason: 'simulation_failed' };
    }
    if (!rpc.Api.isSimulationSuccess(simResponse)) {
      return { success: false, errorReason: 'simulation_failed' };
    }

    // Held through polling-to-confirmation, not just through submission —
    // releasing the lock right after sendTransaction() returns PENDING
    // would let the next queued caller fetch the account before this
    // transaction actually lands on-chain, handing it the same
    // now-stale sequence number instead of a genuinely fresh one. See
    // facilitator-signer.ts's withFacilitatorSubmissionLock.
    const submission = await withFacilitatorSubmissionLock(async (): Promise<
      { ok: true; hash: string; returnValue: unknown } | { ok: false; result: OpenChannelResult }
    > => {
      try {
        const facilitatorAccount = await server.getAccount(signer.address);
        const sorobanData = simResponse.transactionData.build();
        const rebuiltTx = new TransactionBuilder(facilitatorAccount, {
          fee: BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASE,
          sorobanData,
        })
          .setTimeout(60)
          .addOperation(Operation.invokeHostFunction(operation))
          .build();

        const { signedTxXdr, error: signError } = await signer.signTransaction(rebuiltTx.toXDR(), {
          networkPassphrase: NETWORK_PASSPHRASE,
        });
        if (signError || !signedTxXdr) {
          return { ok: false, result: { success: false, errorReason: 'signing_failed' } };
        }

        const txToSubmit = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
        const sendResult = await server.sendTransaction(txToSubmit);
        if (sendResult.status !== 'PENDING') {
          return { ok: false, result: { success: false, errorReason: 'submission_failed' } };
        }

        const confirmed = await this.pollForTransaction(server, sendResult.hash);
        if (!confirmed.success) {
          return { ok: false, result: { success: false, errorReason: 'transaction_failed', transaction: sendResult.hash } };
        }
        return { ok: true, hash: sendResult.hash, returnValue: confirmed.returnValue };
      } catch (err) {
        this.logger.error(`open_channel submission failed: ${err}`);
        return { ok: false, result: { success: false, errorReason: 'submission_failed' } };
      }
    });

    if (!submission.ok) {
      return submission.result;
    }

    const onchainChannelId = (submission.returnValue as bigint).toString();
    await pool.query(
      `INSERT INTO x402_channels (onchain_channel_id, payer_address, payee_address, asset_contract, payer_pubkey, deposited, resource_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (onchain_channel_id) DO NOTHING`,
      [onchainChannelId, payerAddress, payeeAddress, tokenAddress, payerPubkey.toString('hex'), deposit.toString(), params.resourceUrl ?? null],
    );

    return { success: true, onchainChannelId, transaction: submission.hash };
  }

  // Same client-signs-facilitator-submits pattern as openChannel — either
  // party (payer or payee) can request a close, so either can be the
  // signer. The contract itself is the real enforcement of "caller must be
  // payer or payee" (initiate_close's own require_auth() + check); the
  // channel_id/caller extraction below exists to give a clean error and
  // skip a wasted simulation for an obviously-wrong call, not to duplicate
  // that enforcement.
  async closeChannel(params: { transactionXdr: string }): Promise<CloseChannelResult> {
    const server = new rpc.Server(RPC_URL);
    let transaction: Transaction;
    try {
      transaction = new Transaction(params.transactionXdr, NETWORK_PASSPHRASE);
    } catch {
      return { success: false, errorReason: 'malformed_transaction' };
    }

    if (transaction.operations.length !== 1) {
      return { success: false, errorReason: 'wrong_operation_count' };
    }
    const operation = transaction.operations[0];
    if (operation.type !== 'invokeHostFunction') {
      return { success: false, errorReason: 'wrong_operation_type' };
    }

    const signer = await getFacilitatorSigner();
    if ((operation.source ?? transaction.source) === signer.address) {
      return { success: false, errorReason: 'unsafe_tx_source' };
    }

    const func = operation.func;
    if (!func || func.type !== 'hostFunctionTypeInvokeContract') {
      return { success: false, errorReason: 'wrong_operation_type' };
    }
    const invokeArgs = func.invokeContract;
    const contractAddress = Address.fromScAddress(invokeArgs.contractAddress).toString();
    const functionName = invokeArgs.functionName.toString();
    const args = invokeArgs.args;
    if (contractAddress !== CHANNEL_CONTRACT_ID) {
      return { success: false, errorReason: 'wrong_contract' };
    }
    if (functionName !== 'initiate_close' || args.length !== 2) {
      return { success: false, errorReason: 'wrong_function' };
    }

    const caller = scValToNative(args[0]) as string;
    const onchainChannelId = (scValToNative(args[1]) as bigint).toString();

    const { rows } = await pool.query(
      `SELECT payer_address, payee_address, status FROM x402_channels WHERE onchain_channel_id = $1`,
      [onchainChannelId],
    );
    if (rows.length === 0) {
      return { success: false, errorReason: 'channel_not_found' };
    }
    const row = rows[0] as { payer_address: string; payee_address: string; status: string };
    if (caller !== row.payer_address && caller !== row.payee_address) {
      return { success: false, errorReason: 'caller_not_a_party' };
    }
    if (row.status !== 'open') {
      return { success: false, errorReason: 'channel_not_open' };
    }

    let simResponse: rpc.Api.SimulateTransactionResponse;
    try {
      simResponse = await server.simulateTransaction(transaction);
    } catch (err) {
      this.logger.error(`initiate_close simulation failed: ${err}`);
      return { success: false, errorReason: 'simulation_failed' };
    }
    if (!rpc.Api.isSimulationSuccess(simResponse)) {
      return { success: false, errorReason: 'simulation_failed' };
    }

    // See openChannel's identical comment — held through confirmation, not
    // just submission.
    const submission = await withFacilitatorSubmissionLock(async (): Promise<
      { ok: true; hash: string } | { ok: false; result: CloseChannelResult }
    > => {
      try {
        const facilitatorAccount = await server.getAccount(signer.address);
        const sorobanData = simResponse.transactionData.build();
        const rebuiltTx = new TransactionBuilder(facilitatorAccount, {
          fee: BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASE,
          sorobanData,
        })
          .setTimeout(60)
          .addOperation(Operation.invokeHostFunction(operation))
          .build();

        const { signedTxXdr, error: signError } = await signer.signTransaction(rebuiltTx.toXDR(), {
          networkPassphrase: NETWORK_PASSPHRASE,
        });
        if (signError || !signedTxXdr) {
          return { ok: false, result: { success: false, errorReason: 'signing_failed' } };
        }

        const txToSubmit = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
        const sendResult = await server.sendTransaction(txToSubmit);
        if (sendResult.status !== 'PENDING') {
          return { ok: false, result: { success: false, errorReason: 'submission_failed' } };
        }

        const confirmed = await this.pollForTransaction(server, sendResult.hash);
        if (!confirmed.success) {
          return { ok: false, result: { success: false, errorReason: 'transaction_failed', transaction: sendResult.hash } };
        }
        return { ok: true, hash: sendResult.hash };
      } catch (err) {
        this.logger.error(`initiate_close submission failed: ${err}`);
        return { ok: false, result: { success: false, errorReason: 'submission_failed' } };
      }
    });

    if (!submission.ok) {
      return submission.result;
    }

    await pool.query(
      `UPDATE x402_channels SET status = 'closing', closing_at = NOW(), updated_at = NOW() WHERE onchain_channel_id = $1`,
      [onchainChannelId],
    );

    return { success: true, transaction: submission.hash };
  }

  // checkpoint() and finalize_close() both need no party's auth entry at
  // all — checkpoint() verifies the claim via a raw ed25519 signature
  // argument (not Soroban account auth), and finalize_close() is fully
  // permissionless by design (see the contract's own doc comment: "anyone
  // can trigger this once the challenge window has elapsed"). That means
  // the facilitator can build, sign, and submit these entirely on its own
  // — no client-provided XDR to parse/relay, unlike open/close above.
  async checkpointChannel(params: {
    onchainChannelId: bigint;
    cumulativeAmount: bigint;
    nonce: bigint;
    signature: Buffer;
  }): Promise<FacilitatorCallResult> {
    return this.submitFacilitatorCall(
      'checkpoint',
      [
        nativeToScVal(params.onchainChannelId, { type: 'u64' }),
        nativeToScVal(params.cumulativeAmount, { type: 'i128' }),
        nativeToScVal(params.nonce, { type: 'u64' }),
        nativeToScVal(params.signature, { type: 'bytes' }),
      ],
      'checkpoint',
    );
  }

  async finalizeCloseChannel(onchainChannelId: bigint): Promise<FacilitatorCallResult> {
    return this.submitFacilitatorCall(
      'finalize_close',
      [nativeToScVal(onchainChannelId, { type: 'u64' })],
      'finalize_close',
    );
  }

  async getChannelInfoOnChain(onchainChannelId: bigint): Promise<unknown> {
    const server = new rpc.Server(RPC_URL);
    const contract = new Contract(CHANNEL_CONTRACT_ID);
    const signer = await getFacilitatorSigner();
    // Simulation-only call — any funded-looking account works as the
    // envelope's source, same reasoning Arbiter's stellarClient.js already
    // documents for its own read-only simulateReadOnly() helper.
    const account = await server.getAccount(signer.address);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .setTimeout(30)
      .addOperation(contract.call('get_channel_info', nativeToScVal(onchainChannelId, { type: 'u64' })))
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
      throw new Error(`get_channel_info simulation failed for channel ${onchainChannelId}`);
    }
    return scValToNative(sim.result.retval);
  }

  private async submitFacilitatorCall(
    functionName: string,
    args: ReturnType<typeof nativeToScVal>[],
    logLabel: string,
  ): Promise<FacilitatorCallResult> {
    const server = new rpc.Server(RPC_URL);
    const signer = await getFacilitatorSigner();
    const contract = new Contract(CHANNEL_CONTRACT_ID);

    // Held through confirmation — see openChannel's identical comment on
    // withFacilitatorSubmissionLock.
    return withFacilitatorSubmissionLock(async (): Promise<FacilitatorCallResult> => {
      let sentHash: string;
      try {
        const account = await server.getAccount(signer.address);
        // Simulated off a disposable clone of `account`, not `account`
        // itself: TransactionBuilder.build() mutates its source Account's
        // sequence number in place, and this simulation-only transaction
        // is never submitted. Building it straight off `account` would
        // silently consume the sequence number the real transaction below
        // still needs, so the real submission would always land two past
        // the last confirmed sequence instead of one — a real, non-
        // concurrency bug found while adding this lock, confirmed by a
        // real checkpointChannel() call against live testnet failing with
        // exactly this shape of error before this fix.
        const simAccount = new Account(account.accountId(), account.sequenceNumber());
        const tx = new TransactionBuilder(simAccount, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
          .setTimeout(60)
          .addOperation(contract.call(functionName, ...args))
          .build();

        const sim = await server.simulateTransaction(tx);
        if (!rpc.Api.isSimulationSuccess(sim)) {
          return { success: false, errorReason: `${logLabel}_simulation_failed` };
        }
        const sorobanData = sim.transactionData.build();
        const prepared = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE, sorobanData })
          .setTimeout(60)
          .addOperation(contract.call(functionName, ...args))
          .build();

        const { signedTxXdr, error: signError } = await signer.signTransaction(prepared.toXDR(), {
          networkPassphrase: NETWORK_PASSPHRASE,
        });
        if (signError || !signedTxXdr) {
          return { success: false, errorReason: `${logLabel}_signing_failed` };
        }

        const txToSubmit = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
        const sendResult = await server.sendTransaction(txToSubmit);
        if (sendResult.status !== 'PENDING') {
          return { success: false, errorReason: `${logLabel}_submission_failed` };
        }
        sentHash = sendResult.hash;
      } catch (err) {
        this.logger.error(`${logLabel} failed: ${err}`);
        return { success: false, errorReason: `${logLabel}_failed` };
      }

      const confirmed = await this.pollForTransaction(server, sentHash);
      if (!confirmed.success) {
        return { success: false, errorReason: `${logLabel}_transaction_failed`, transaction: sentHash };
      }
      return { success: true, transaction: sentHash, returnValue: confirmed.returnValue };
    });
  }

  private async pollForTransaction(
    server: rpc.Server,
    txHash: string,
    maxAttempts = 15,
    delayMs = 1000,
  ): Promise<{ success: boolean; returnValue?: unknown }> {
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
        // NOT_FOUND while still pending — expected, keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return { success: false };
  }
}
