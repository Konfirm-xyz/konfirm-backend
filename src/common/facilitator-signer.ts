import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createEd25519Signer } from '@x402/stellar';
import type { Ed25519Signer } from '@x402/stellar';
import { Keypair } from '@stellar/stellar-sdk';
import { createKmsEd25519Signer } from './kms-ed25519-signer';
import { NETWORK_CAIP2, TREASURY_SIGNERS } from './stellar-network';

const execFileAsync = promisify(execFile);

// The facilitator is the hot key: it signs x402 settlements, channel
// submissions, and sweeps. It must not be the same key as the deployer,
// which is the admin of the Soroban contracts and one of the treasury
// signers. A leak of that key would then give an attacker both spend
// authority and admin authority.
//
// Resolution order:
//   1. FACILITATOR_KMS_KEY_ID: KMS holds the key, nothing secret in env.
//   2. FACILITATOR_SECRET_KEY: a dedicated raw key, for environments
//      without KMS.
//   3. Outside production only: the deployer key (STELLAR_DEPLOYER_SECRET_KEY
//      or the local `deployer` CLI identity), with a warning. Production
//      never falls back to it.
async function resolveFacilitatorSecretKey(): Promise<string | null> {
  const dedicated = process.env.FACILITATOR_SECRET_KEY;
  if (dedicated) return dedicated;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'production needs FACILITATOR_KMS_KEY_ID or FACILITATOR_SECRET_KEY — refusing to sign with the deployer key',
    );
  }
  // eslint-disable-next-line no-console
  console.warn('[facilitator] using the deployer key for signing — dev only. Set FACILITATOR_SECRET_KEY.');
  const fromEnv = process.env.STELLAR_DEPLOYER_SECRET_KEY;
  if (fromEnv) return fromEnv;
  const { stdout } = await execFileAsync('stellar', ['keys', 'secret', 'deployer']);
  return stdout.trim();
}

// Fails at boot if two of the three hot identities resolve to the same
// account. Only checked when the secrets are actually present; a missing
// one is caught by the resolution above. A KMS-backed facilitator has no
// secret here to compare; see assertKmsFacilitatorIsSeparate below.
export function assertSeparateHotKeys(env: NodeJS.ProcessEnv = process.env): void {
  const accounts: Array<[string, string]> = [];
  const add = (label: string, secret: string | undefined) => {
    if (!secret) return;
    try {
      accounts.push([label, Keypair.fromSecret(secret).publicKey()]);
    } catch {
      throw new Error(`${label} is not a valid Stellar secret key`);
    }
  };
  add('STELLAR_DEPLOYER_SECRET_KEY', env.STELLAR_DEPLOYER_SECRET_KEY);
  add('FACILITATOR_SECRET_KEY', env.FACILITATOR_SECRET_KEY);
  add('PLATFORM_FEE_SECRET_KEY', env.PLATFORM_FEE_SECRET_KEY);
  for (let i = 0; i < accounts.length; i++) {
    for (let j = i + 1; j < accounts.length; j++) {
      if (accounts[i][1] === accounts[j][1]) {
        throw new Error(`${accounts[i][0]} and ${accounts[j][0]} are the same account — each hot identity needs its own key`);
      }
    }
  }
}

// The KMS path never has a facilitator secret in env, so assertSeparateHotKeys
// can't see it. Once the KMS signer has derived its address, compare that
// address against every deployer / platform-fee identity that is configured,
// whether as a secret key or as a public address. Same "only when present"
// rule as above.
export function assertKmsFacilitatorIsSeparate(facilitatorAddress: string, env: NodeJS.ProcessEnv = process.env): void {
  const others: Array<[string, string]> = [];
  const addSecret = (label: string, secret: string | undefined) => {
    if (!secret) return;
    try {
      others.push([label, Keypair.fromSecret(secret).publicKey()]);
    } catch {
      throw new Error(`${label} is not a valid Stellar secret key`);
    }
  };
  const addAddress = (label: string, address: string | undefined) => {
    if (address) others.push([label, address]);
  };
  addSecret('STELLAR_DEPLOYER_SECRET_KEY', env.STELLAR_DEPLOYER_SECRET_KEY);
  addAddress('DEPLOYER_ADDRESS', env.DEPLOYER_ADDRESS);
  addSecret('PLATFORM_FEE_SECRET_KEY', env.PLATFORM_FEE_SECRET_KEY);
  addAddress('PLATFORM_FEE_ADDRESS', env.PLATFORM_FEE_ADDRESS);
  for (const [label, address] of others) {
    if (address === facilitatorAddress) {
      throw new Error(`FACILITATOR_KMS_KEY_ID and ${label} are the same account — each hot identity needs its own key`);
    }
  }
}

let signerPromise: Promise<Ed25519Signer> | null = null;

// Treasury signers (deployer/signer2/signer3) are cold identities: they
// only ever sign propose_settlement/approve_settlement/execute_settlement,
// never a hot path. Each one is configured as a KMS key id
// (TREASURY_SIGNER_KMS_KEY_IDS, comma-separated, same order as
// TREASURY_SIGNERS) so the private key material never exists in this
// process -- see kms-ed25519-signer.ts. Memoized per key id: deriving the
// address is a KMS GetPublicKey round trip, not something to repeat per
// request.
const treasurySignerPromises = new Map<string, Promise<Ed25519Signer>>();

export function getTreasurySigner(kmsKeyId: string): Promise<Ed25519Signer> {
  let promise = treasurySignerPromises.get(kmsKeyId);
  if (!promise) {
    promise = createKmsEd25519Signer(kmsKeyId);
    treasurySignerPromises.set(kmsKeyId, promise);
  }
  return promise;
}

// Resolves the KMS key id configured for a treasury signer's on-chain
// address. Returns null when that signer has no KMS key configured, which
// is the signal to fall back to the manual Freighter build/submit path --
// this ships dark, exactly like FACILITATOR_KMS_KEY_ID does.
export function treasurySignerKeyIdFor(address: string): string | null {
  const keyIds = (process.env.TREASURY_SIGNER_KMS_KEY_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const index = TREASURY_SIGNERS.indexOf(address);
  if (index === -1) return null;
  return keyIds[index] ?? null;
}

// Ships dark: FACILITATOR_KMS_KEY_ID unset means byte-for-byte the same
// behavior as before this change (raw secret key, env var or CLI
// identity). Setting it switches to a KMS-backed signer where the private
// key material never exists in this process at all -- see
// kms-ed25519-signer.ts. The on-chain address changes when this flips
// (KMS generates its own key material, it can't import the existing raw
// key), so this is a real cutover with its own runbook, not a toggle to
// flip casually in production without funding the new address first.
export function getFacilitatorSigner(): Promise<Ed25519Signer> {
  if (!signerPromise) {
    const kmsKeyId = process.env.FACILITATOR_KMS_KEY_ID;
    signerPromise = kmsKeyId
      ? createKmsEd25519Signer(kmsKeyId).then((signer) => {
          assertKmsFacilitatorIsSeparate(signer.address);
          return signer;
        })
      : resolveFacilitatorSecretKey().then((secretKey) => {
          if (!secretKey) throw new Error('no facilitator key configured');
          assertSeparateHotKeys();
          return createEd25519Signer(secretKey, NETWORK_CAIP2);
        });
  }
  return signerPromise;
}

// Stellar allows exactly one in-flight transaction per source account
// sequence number. Every facilitator-submitted transaction — x402 single-
// shot settlement, channel open/close, and the keeper's checkpoint/
// finalize_close — signs with this same signer/account, so two of them
// racing (e.g. two concurrent /x402/settle calls, or a settle landing
// mid-sweep) independently fetch the same "current" sequence number and
// only one submission survives; the other fails with a bad-sequence
// error. A simple promise-chained queue serializes just the
// fetch-sequence-through-submit critical section across every call site
// sharing this signer, without needing a distributed lock — there is only
// ever one process holding this signer's key. Chained with `.then(fn, fn)`
// rather than `.finally()` so the queue always advances to the next
// waiter regardless of whether the previous submission succeeded or
// threw — a `.finally()` here would still surface the rejection.
let submissionQueue: Promise<unknown> = Promise.resolve();

export function withFacilitatorSubmissionLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = submissionQueue.then(fn, fn);
  submissionQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Same one-in-flight-per-source-account reasoning as above, but keyed by
// the treasury signer's own address: each treasury signer is a distinct
// account with its own sequence number, so two settlements signed by the
// same signer must not race, while signer2 and signer3 can proceed in
// parallel.
const treasurySubmissionQueues = new Map<string, Promise<unknown>>();

export function withTreasurySignerSubmissionLock<T>(address: string, fn: () => Promise<T>): Promise<T> {
  const previous = treasurySubmissionQueues.get(address) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  treasurySubmissionQueues.set(
    address,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
