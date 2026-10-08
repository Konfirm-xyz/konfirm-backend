// Spike for docs/specs/03-deployer-admin.md, step 1: can a 2-of-3 multisig
// Stellar account administer a Soroban contract?
//
// Everything here is testnet with throwaway, Friendbot-funded accounts. The
// question it answers: does `require_auth` on an admin G-account accept a
// multi-signature authorization, and does it refuse one signature when the
// threshold is two?
//
//   baseline  : single signature, before any change      -> expect success
//   convert   : add 3 signers, thresholds 2, master 0    -> needs 2 signatures
//   one sig   : admin call, one signer's authorization    -> expect failure
//   two sigs  : admin call, two signers' authorization    -> expect success
//
// Run: node scripts/spike/multisig-admin.mjs <compliance_contract_id>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  authorizeEntry, Account, Address, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal, rpc, xdr, hash,
} from '@stellar/stellar-sdk';

const RPC_URL = 'https://soroban-testnet.stellar.org';
const PASSPHRASE = Networks.TESTNET;
const rpcServer = new rpc.Server(RPC_URL);

async function fund(kp) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot ${res.status} for ${kp.publicKey()}`);
}

async function accountOf(address) {
  const acc = await rpcServer.getAccount(address);
  return new Account(address, acc.sequenceNumber());
}

// Signs a Soroban authorization for a classic account with a set of signers.
// The SDK builds the exact payload the protocol verifies (including the V2
// address-bound preimage), and calls our callback with it. The callback returns
// the signature vector: one {public_key, signature} entry per signer, sorted by
// public key, which the host checks against the account's signers and thresholds.
async function signAuthWith(entry, signers, validUntil, accountAddress) {
  return authorizeEntry(
    entry,
    async (_preimage, payload) => {
      const sigs = signers
        .map((kp) => ({ pk: kp.rawPublicKey(), sig: kp.sign(payload) }))
        .sort((a, b) => Buffer.compare(a.pk, b.pk))
        .map(({ pk, sig }) =>
          xdr.ScVal.scvMap([
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('public_key'), val: xdr.ScVal.scvBytes(pk) }),
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('signature'), val: xdr.ScVal.scvBytes(sig) }),
          ]),
        );
      return { signatureScVal: xdr.ScVal.scvVec(sigs), address: accountAddress };
    },
    validUntil,
    PASSPHRASE,
    accountAddress,
  );
}

// Invokes a contract function. The admin account is always the transaction
// source (its sequence number is used). `authSigners` sign the Soroban
// authorization for the admin account. `txSigners` sign the envelope.
async function invoke({ contractId, source, fn, args, authSigners, txSigners }) {
  const contract = new Address(contractId).toScAddress();
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({ contractAddress: contract, functionName: fn, args }),
  );

  // 1. Simulate with no authorization, to learn what must be signed and the footprint.
  const simTx = new TransactionBuilder(await accountOf(source), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.invokeHostFunction({ func, auth: [] }))
    .setTimeout(60)
    .build();
  const sim = await rpcServer.simulateTransaction(simTx);
  if (rpc.Api.isSimulationError(sim)) return { ok: false, stage: 'simulate', error: sim.error };

  // 2. Sign each authorization for the admin account with the given signers.
  const validUntil = (await rpcServer.getLatestLedger()).sequence + 200;
  const auth = [];
  for (const entry of sim.result.auth) {
    const creds = entry.credentials;
    if (creds.type === 'sorobanCredentialsSourceAccount') {
      auth.push(entry);
      continue;
    }
    // V1 credentials keep the address in `address`, V2 in `addressV2`.
    const inner = creds.address ?? creds.addressV2 ?? creds.addressWithDelegates;
    const who = Address.fromScAddress(inner.address).toString();
    auth.push(await signAuthWith(entry, authSigners, validUntil, who));
  }

  // 3. Re-simulate with the signed authorization. A signed auth changes the
  // footprint and resource cost, so the first simulation's numbers are stale.
  const withAuth = new TransactionBuilder(await accountOf(source), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(60)
    .build();
  const sim2 = await rpcServer.simulateTransaction(withAuth);
  if (rpc.Api.isSimulationError(sim2)) return { ok: false, stage: 'preflight', error: sim2.error };

  // 4. Build the final transaction with the fresh footprint and fee, then sign it.
  const tx = new TransactionBuilder(await accountOf(source), {
    fee: String(Number(sim2.minResourceFee) + Number(BASE_FEE) * 100),
    networkPassphrase: PASSPHRASE,
    sorobanData: sim2.transactionData.build(),
  })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(60)
    .build();
  for (const kp of txSigners) tx.sign(kp);

  // Simulate the signed transaction first. A trap then reports its reason, which the
  // on-ledger result code alone does not.
  const dry = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(dry)) return { ok: false, stage: 'resimulate', error: String(dry.error).slice(0, 600) };

  // 5. Submit and wait.
  const sent = await rpcServer.sendTransaction(tx);
  if (sent.status === 'ERROR') return { ok: false, stage: 'preflight', error: String(sent.errorResult?.toXDR?.('base64')) };
  for (let i = 0; i < 40; i++) {
    const got = await rpcServer.getTransaction(sent.hash);
    if (got.status === 'SUCCESS') return { ok: true, hash: sent.hash };
    if (got.status === 'FAILED') {
      // Wire form: the transaction code, and the operation's host-function code
      // (-2 means the contract trapped, which is where a failed require_auth lands).
      const wire = got.resultXdr?.toXdrObject?.();
      const code = wire?.result?.code;
      const opCode = wire?.result?.results?.[0]?.tr?.invokeHostFunctionResult?.code;
      return { ok: false, stage: 'execute', hash: sent.hash, code, opCode };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, stage: 'timeout', hash: sent.hash };
}

const WASM = '/Users/mac/konfirm/konfirm-contracts/target/wasm32v1-none/release/konfirm_compliance.wasm';

const admin = Keypair.random();
const s1 = Keypair.random();
const s2 = Keypair.random();
const s3 = Keypair.random();
// A separate account submits every invoke. Its signature is the only one on the
// envelope, so any authorization that passes must come from the admin's auth
// entries, not from the envelope. Without this, the test couldn't tell them apart.
const submitter = Keypair.random();
for (const kp of [admin, s1, s2, s3, submitter]) await fund(kp);

// A fresh compliance contract whose admin is this spike's admin account.
// Retried: the testnet RPC drops connections now and then.
let contractId;
for (let attempt = 1; attempt <= 4 && !contractId; attempt++) {
  try {
    contractId = execFileSync(
      'stellar',
      ['contract', 'deploy', '--wasm', WASM, '--source-account', admin.secret(), '--network', 'testnet', '--', '--admin', admin.publicKey()],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim().split('\n').pop();
  } catch (err) {
    console.log(`deploy attempt ${attempt} failed, retrying`);
    await new Promise((r) => setTimeout(r, 8000));
  }
}
if (!contractId) throw new Error('contract deploy failed after retries');
console.log('contract:', contractId);

// `initialize` is a separate call. A contract with no constructor isn't set up by
// passing `--admin` at deploy time, which is what the contracts README says to do.
const init = await invoke({
  contractId, source: admin.publicKey(), fn: 'initialize', args: [new Address(admin.publicKey()).toScVal()],
  authSigners: [admin], txSigners: [admin],
});
console.log('initialize:', JSON.stringify(init));
if (!init.ok) throw new Error('initialize failed');

const target = Keypair.random().publicKey();
const blockArgs = () => [new Address(target).toScVal()];
const report = {};

// The admin is only ever the admin of its own contract, so this spike deploys
// its own. See the contract deploy step in the notes; the contract id is passed in.
report.baseline = await invoke({
  contractId, source: admin.publicKey(), fn: 'block_address', args: blockArgs(), authSigners: [admin], txSigners: [admin],
});
console.log('baseline (1 sig, pre-conversion):', JSON.stringify(report.baseline));

// Conversion, in the order the spec requires. Each step is its own transaction.
const convertAcc = await accountOf(admin.publicKey());
const addSigners = new TransactionBuilder(convertAcc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
  .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: s1.publicKey(), weight: 1 } }))
  .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: s2.publicKey(), weight: 1 } }))
  .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: s3.publicKey(), weight: 1 } }))
  .addOperation(Operation.setOptions({ lowThreshold: 2, medThreshold: 2, highThreshold: 2 }))
  .setTimeout(60).build();
addSigners.sign(admin);
let r = await rpcServer.sendTransaction(addSigners);
report.addSigners = r.status;
for (let i = 0; i < 30; i++) { const g = await rpcServer.getTransaction(r.hash); if (g.status !== 'NOT_FOUND') { report.addSignersResult = g.status; break; } await new Promise((x) => setTimeout(x, 1500)); }
console.log('step 1 (add signers, thresholds 2):', report.addSignersResult);

const dropAcc = await accountOf(admin.publicKey());
const dropMaster = new TransactionBuilder(dropAcc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
  .addOperation(Operation.setOptions({ masterWeight: 0 }))
  .setTimeout(60).build();
dropMaster.sign(admin, s1);
r = await rpcServer.sendTransaction(dropMaster);
for (let i = 0; i < 30; i++) { const g = await rpcServer.getTransaction(r.hash); if (g.status !== 'NOT_FOUND') { report.dropMaster = g.status; break; } await new Promise((x) => setTimeout(x, 1500)); }
console.log('step 2 (master weight 0, signed by admin + s1):', report.dropMaster);

report.adminAloneAfterConversion = await invoke({
  contractId, source: submitter.publicKey(), fn: 'block_address', args: blockArgs(), authSigners: [admin], txSigners: [submitter],
});
console.log('admin key alone (weight 0, expect failure):', JSON.stringify(report.adminAloneAfterConversion));

report.oneSig = await invoke({
  contractId, source: submitter.publicKey(), fn: 'block_address', args: blockArgs(), authSigners: [s1], txSigners: [submitter],
});
console.log('one signer authorizes (expect failure):', JSON.stringify(report.oneSig));

report.twoSigs = await invoke({
  contractId, source: submitter.publicKey(), fn: 'block_address', args: blockArgs(), authSigners: [s1, s2], txSigners: [submitter],
});
console.log('two signers authorize (expect success):', JSON.stringify(report.twoSigs));

// The thresholds and signers, read back from the ledger rather than assumed.
const onChain = await fetch(`https://horizon-testnet.stellar.org/accounts/${admin.publicKey()}`).then((r) => r.json());
report.onChainThresholds = onChain.thresholds;
report.onChainSigners = onChain.signers.map((x) => ({ key: x.key.slice(0, 6), weight: x.weight }));
console.log(JSON.stringify(report, null, 2));
