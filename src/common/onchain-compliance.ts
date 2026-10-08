/// <reference path="./stellar-sdk-contract.d.ts" />
import { Client } from '@stellar/stellar-sdk/contract';
import type { AssembledTransaction, MethodOptions } from '@stellar/stellar-sdk/contract';
import { Networks } from '@stellar/stellar-sdk';
import { withRetry } from './retry';
import { NETWORK_PASSPHRASE, RPC_URL } from './stellar-network';
import { COMPLIANCE_CONTRACT_ID, DEPLOYER_ADDRESS } from './stellar-network';


// Used purely as the simulation source account for a read-only call —
// is_allowed never mutates state, so this account never signs or pays a
// fee. It just needs to be a real, existing testnet account (simulation
// still needs a valid source-account context); the already-funded deployer
// identity used elsewhere this session is a convenient, known-good choice,
// not a privileged one for this specific call.

interface ComplianceContract {
  is_allowed(args: { addr: string }, options?: MethodOptions): Promise<AssembledTransaction<boolean>>;
}

// Constructed once and reused — Client.from() does a real network round
// trip (fetching the contract's spec) the first time, ~1s; every call
// after that is a single fast simulate-only RPC round trip (no signing, no
// submission).
// Cleared on any failure (see isAllowedOnChain) rather than left cached
// forever: a promise that never resolves would otherwise poison every
// future call for the lifetime of the process, since awaiting an
// already-hung promise a second time doesn't give it a second chance.
let clientPromise: Promise<Client & ComplianceContract> | null = null;
function getClient(): Promise<Client & ComplianceContract> {
  if (!clientPromise) {
    clientPromise = Client.from<ComplianceContract>({
      contractId: COMPLIANCE_CONTRACT_ID,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      publicKey: DEPLOYER_ADDRESS,
    });
  }
  return clientPromise;
}

// Direct Soroban RPC call to the deployed compliance contract's
// `is_allowed`, replacing the previous `stellar contract invoke` CLI
// subprocess (used identically by payments.service.ts and x402.service.ts
// until now) — no CLI binary, no container-runtime shared-library
// dependencies, and meaningfully faster (a single simulate-only RPC call
// vs. spawning and waiting on an external process). Same documented
// invariant as before: fails open, loudly, on any error — an unreachable
// compliance check must never silently block a payment, but must never be
// silent about it either.
//
// Client construction (getClient()) and the actual call both happen
// *inside* the retried, timeout-bounded closure — not just the call. A
// native `execFile` timeout (the old CLI approach) really kills the child
// process; a Promise-based race around only *part* of an async chain
// doesn't stop the untimed part from hanging indefinitely, it just stops
// the caller from waiting on it. Wrapping both together is what actually
// bounds this call's worst-case latency now that there's no child process
// to kill.
export async function isAllowedOnChain(address: string): Promise<boolean> {
  try {
    const tx = await withRetry(
      async () => {
        const client = await getClient();
        return client.is_allowed({ addr: address });
      },
      { retries: 1, baseDelayMs: 500, timeoutMs: 8_000 },
    );
    return tx.result;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[compliance] on-chain check unreachable, failing open:', err);
    clientPromise = null;
    return true;
  }
}
