/// <reference path="./stellar-sdk-contract.d.ts" />
import { Client } from '@stellar/stellar-sdk/contract';
import type { AssembledTransaction, MethodOptions } from '@stellar/stellar-sdk/contract';
import { Networks } from '@stellar/stellar-sdk';
import { withRetry } from './retry';
import { NETWORK_PASSPHRASE, RPC_URL } from './stellar-network';
import { COMPLIANCE_CONTRACT_ID, COMPLIANCE_CANARY_ADDRESS, DEPLOYER_ADDRESS } from './stellar-network';


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

export interface ComplianceCanaryResult {
  // Whether COMPLIANCE_CANARY_ADDRESS is set at all. A deploy with no
  // canary configured isn't a breach — it just means this check can't run
  // yet (see docs/specs/03-deployer-admin.md for the seeding step).
  configured: boolean;
  // Null when not configured. True means the canary is behaving as
  // expected (blocked); false is the actual breach signal (backend#210) —
  // a contract that's silently uninitialized, pointed at the wrong
  // contract ID, or had its canary accidentally cleared.
  ok: boolean | null;
}

// Detects the specific gap backend#210 describes: isAllowedOnChain()'s
// success path trusts tx.result unconditionally, so a compliance contract
// that's uninitialized (or just misconfigured to the wrong ID) produces no
// exception and no signal — it looks identical to "everyone's cleared".
// konfirm-contracts#189 already made is_allowed() fail closed on an
// uninitialized contract (returns false with no Admin key set), which
// closes the catastrophic "everyone silently allowed" case structurally.
// This canary check is the detection layer the issue still asks for on
// top of that: one address deliberately block_address()'d per environment
// immediately after initialize (see the runbook), continuously reprobed.
// If it ever reads back as allowed, something is wrong with compliance
// screening itself, independent of any one payment's outcome.
//
// Deliberately reuses isAllowedOnChain rather than a bespoke client call:
// an RPC outage already fails open there (loudly, via the existing
// console.warn) and would make this read back as "canary cleared" too —
// an indistinguishable false alarm during a real RPC outage is the
// intentional, safer failure mode here, not a bug to route around.
export async function checkComplianceCanary(): Promise<ComplianceCanaryResult> {
  if (!COMPLIANCE_CANARY_ADDRESS) {
    return { configured: false, ok: null };
  }
  const allowed = await isAllowedOnChain(COMPLIANCE_CANARY_ADDRESS);
  if (allowed) {
    // Distinct from the RPC-fail-open warning above: this is the "screening
    // itself may not be running" alarm backend#210 asks for, not a transient
    // connectivity blip. error level (not warn) and a distinct, greppable
    // prefix so it can be wired to real alerting later without re-deriving
    // which log lines matter.
    // eslint-disable-next-line no-console
    console.error('[compliance] CANARY BREACH: canary address reads as allowed — compliance screening may not be running', {
      canary: COMPLIANCE_CANARY_ADDRESS,
    });
  }
  return { configured: true, ok: !allowed };
}
