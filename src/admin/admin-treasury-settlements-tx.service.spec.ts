import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { pool } from '../db/pool';
import { NETWORK_PASSPHRASE, DEPLOYER_ADDRESS, TREASURY_SIGNERS } from '../common/stellar-network';
import { AdminTreasurySettlementsService } from './admin-treasury-settlements.service';

const execFileAsync = promisify(execFile);

// Real testnet RPC, the real redeployed treasury contract, and real signer
// keys -- the same local `deployer`/`signer2` CLI identities already
// proven live in PR #220 / docs/VERIFY.md's propose->approve->execute
// evidence. Part of the 'live' suite (see jest.config.js), not 'fast'.
//
// This proves the actual gap the sibling spec
// (admin-treasury-settlements.service.spec.ts) doesn't: that
// buildProposeTx/buildApproveTx/buildExecuteTx/submitSigned -- the new
// build-unsigned-tx -> client-signs -> submit-signed-tx round trip --
// really works end to end against the live contract, not just that
// registerOrResync can read a settlement someone else created out of band
// with the raw CLI.
//
// Secrets are never typed into a command string or logged -- retrieved at
// runtime via the local `stellar` CLI keyring, the same resolution
// facilitator-signer.ts already falls back to outside production.
async function secretFor(identity: string): Promise<string> {
  const { stdout } = await execFileAsync('stellar', ['keys', 'secret', identity]);
  return stdout.trim();
}

describe('AdminTreasurySettlementsService build/submit (live testnet)', () => {
  const service = new AdminTreasurySettlementsService();
  let deployerKeypair: Keypair;
  let signer2Keypair: Keypair;
  const createdSettlementIds: bigint[] = [];

  beforeAll(async () => {
    deployerKeypair = Keypair.fromSecret(await secretFor('deployer'));
    signer2Keypair = Keypair.fromSecret(await secretFor('signer2'));
    // Not a tautology: proves the local CLI keyring these tests sign with
    // actually resolves to the real on-chain treasury signer addresses
    // (konfirm-contracts/README.md's "Treasury signers"), not some other
    // unrelated local identity that happens to share the names.
    expect(deployerKeypair.publicKey()).toBe(DEPLOYER_ADDRESS);
    expect(TREASURY_SIGNERS).toContain(signer2Keypair.publicKey());
  });

  afterEach(async () => {
    if (createdSettlementIds.length) {
      await pool.query('DELETE FROM treasury_settlements WHERE onchain_settlement_id = ANY($1::bigint[])', [createdSettlementIds]);
      createdSettlementIds.length = 0;
    }
    await pool.query('DELETE FROM treasury_settlement_builds WHERE signer_address = $1', [DEPLOYER_ADDRESS]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('builds, signs, and submits a real propose_settlement, then a real approve_settlement, reaching 2-of-3', async () => {
    const merchant = Keypair.random().publicKey();

    const proposeBuild = await service.buildProposeTx(DEPLOYER_ADDRESS, merchant, '0.0000100');
    expect(proposeBuild.unsigned_xdr).toBeTruthy();
    expect(proposeBuild.network_passphrase).toBe(NETWORK_PASSPHRASE);
    expect(proposeBuild.tx_hash).toMatch(/^[0-9a-f]{64}$/);

    const proposeTx = TransactionBuilder.fromXDR(proposeBuild.unsigned_xdr, NETWORK_PASSPHRASE);
    proposeTx.sign(deployerKeypair);
    const proposeResult = await service.submitSigned(proposeTx.toXDR(), proposeBuild.build_token);

    expect(proposeResult.merchant_address).toBe(merchant);
    expect(proposeResult.amount).toBe('100'); // 0.0000100 USDC -> 100 stroops, the contract's raw i128 unit
    expect(proposeResult.approvals_count).toBe(1);
    expect(proposeResult.status).toBe('Pending');
    const settlementId = BigInt(proposeResult.onchain_settlement_id);
    createdSettlementIds.push(settlementId);

    const approveBuild = await service.buildApproveTx(signer2Keypair.publicKey(), settlementId);
    const approveTx = TransactionBuilder.fromXDR(approveBuild.unsigned_xdr, NETWORK_PASSPHRASE);
    approveTx.sign(signer2Keypair);
    const approveResult = await service.submitSigned(approveTx.toXDR(), approveBuild.build_token);

    expect(approveResult.onchain_settlement_id).toBe(proposeResult.onchain_settlement_id);
    expect(approveResult.approvals_count).toBe(2);
    expect(approveResult.status).toBe('Pending');
  }, 90_000);

  it('builds and submits a real execute_settlement for a threshold-met settlement -- traps safely because the treasury has 0 USDC, leaving it Pending rather than falsely Executed', async () => {
    const merchant = Keypair.random().publicKey();

    const proposeBuild = await service.buildProposeTx(DEPLOYER_ADDRESS, merchant, '0.0000100');
    const proposeTx = TransactionBuilder.fromXDR(proposeBuild.unsigned_xdr, NETWORK_PASSPHRASE);
    proposeTx.sign(deployerKeypair);
    const proposeResult = await service.submitSigned(proposeTx.toXDR(), proposeBuild.build_token);
    const settlementId = BigInt(proposeResult.onchain_settlement_id);
    createdSettlementIds.push(settlementId);

    const approveBuild = await service.buildApproveTx(signer2Keypair.publicKey(), settlementId);
    const approveTx = TransactionBuilder.fromXDR(approveBuild.unsigned_xdr, NETWORK_PASSPHRASE);
    approveTx.sign(signer2Keypair);
    await service.submitSigned(approveTx.toXDR(), approveBuild.build_token);

    // The trap can surface at either stage: Soroban's simulation actually
    // executes the contract (including the token transfer), so an
    // underfunded treasury can fail buildExecuteTx's own simulation before
    // a transaction even exists to sign -- or, if simulation somehow
    // passed, at submitSigned's confirmation poll. Caught at whichever
    // stage it happens, same real evidence either way: per docs/VERIFY.md
    // the testnet treasury holds 0 USDC as of this writing, so this is
    // expected to trap, not succeed.
    let threw = false;
    try {
      const executeBuild = await service.buildExecuteTx(DEPLOYER_ADDRESS, settlementId);
      const executeTx = TransactionBuilder.fromXDR(executeBuild.unsigned_xdr, NETWORK_PASSPHRASE);
      executeTx.sign(deployerKeypair);
      await service.submitSigned(executeTx.toXDR(), executeBuild.build_token);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Re-read the real on-chain state directly (not the failed call's
    // never-reached registerOrResync) and confirm the revert-on-trap
    // guarantee held: still Pending, not Executed and not silently marked
    // paid when no money moved.
    const resynced = await service.registerOrResync(settlementId);
    expect(resynced.status).toBe('Pending');
  }, 90_000);

  it('rejects a submit whose signed transaction does not hash to what was built (tamper detection)', async () => {
    const merchantA = Keypair.random().publicKey();
    const merchantB = Keypair.random().publicKey();

    const buildA = await service.buildProposeTx(DEPLOYER_ADDRESS, merchantA, '0.0000100');
    const buildB = await service.buildProposeTx(DEPLOYER_ADDRESS, merchantB, '0.0000200');

    // A genuinely, validly-signed transaction -- just not the one build A's
    // tx_hash was recorded for. Proves the hash check catches a swapped
    // transaction, not merely an invalid signature (adding a correct
    // signature never changes a transaction's hash).
    const txB = TransactionBuilder.fromXDR(buildB.unsigned_xdr, NETWORK_PASSPHRASE);
    txB.sign(deployerKeypair);

    await expect(service.submitSigned(txB.toXDR(), buildA.build_token)).rejects.toThrow(/not the one Konfirm built/);

    await pool.query('DELETE FROM treasury_settlement_builds WHERE id = ANY($1::uuid[])', [[buildA.build_token, buildB.build_token]]);
  });
});
