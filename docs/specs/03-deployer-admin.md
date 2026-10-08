# Spec 3: Deployer as contract admin

**Status:** decision needed, and the first steps need hands-on work from you.
**Priority:** high. This is the one security item on this list.

## The problem

The deployer account (`GAEMG5…ZATJS`) is:

- the admin of the `compliance`, `payment`, and `channel` contracts, set once in `initialize`;
- one of three treasury signers;
- the default simulation source in the backend (now `DEPLOYER_ADDRESS`).

The contracts have no admin rotation function. So a single leaked deployer key lets someone block or unblock addresses, pause the contracts, and act as treasury signer #1. A treasury needs two signatures to move funds, so the deployer alone can't empty it, but it removes the separation of duties we claim.

## Options

**A. Make the deployer account a multisig (no redeploy).** Stellar accounts can require several signatures. Set the deployer's master weight to 0, add three signers, and set the thresholds to 2. The existing contracts keep their addresses, and `require_auth` on the admin address then needs two signatures.

**B. Redeploy with a rotation function.** Add `set_admin` (or a two-step `propose_admin` / `accept_admin`) to each contract, deploy new instances, and update every address in the code and docs. Cleaner in the long run, and costs a redeploy plus an update across the repos.

**C. Leave it.** Document the risk and accept it for the pilot. I don't recommend this.

## Recommendation

**Do A now, and B in the next contract release.** A makes the risk go away today without new code. B fixes the underlying gap, so admin can be rotated when someone leaves the team.

Also: the **treasury signers should not include the deployer.** Replace treasury signer #1 with a key held by a different person. That's a `propose_settlement` / `approve_settlement` change the signers agree to, so it's a human decision, not a code one.

## What you need to decide

1. Who holds the three multisig keys. Use three different people, or two people and one hardware key, but never one person holding two.
2. Whether to replace the deployer as a treasury signer, and with which key.
3. Whether to redeploy for `set_admin` in the next release, or wait until the contracts change for another reason.

## Build plan

**Step 1: spike on testnet (about an hour).**
- Create a throwaway account, with a funded deployer-like admin, and a compliance contract instance.
- Convert the admin account to a 2-of-3 multisig with `setOptions` (signers and thresholds). Check the order: add the new signers and thresholds first, and only then drop the master weight to 0. Doing it the other way round locks the account.
- Call an admin-only function (`block_address`) with one signature, expect failure. Call it with two, expect success. This confirms that Soroban's `require_auth` accepts a multisig account. **This is the check the whole plan depends on. Do not skip it.**

**Step 2: real rotation (on testnet first).**
- Repeat on the real deployer account, after the spike passes.
- Record the signers and thresholds in `docs/KEYS.md`.
- Remove `STELLAR_DEPLOYER_SECRET_KEY` from every environment. The backend only needs the deployer's public address (`DEPLOYER_ADDRESS`).

**Step 3: treasury signer change.** Propose and approve a treasury settlement that replaces the deployer as signer. This is a real treasury action, so it needs the other two signers.

**Step 4 (next contract release): `set_admin`.** Add it with a two-step handover, test it, and redeploy.

## Acceptance criteria

- The spike shows one signature fails and two succeed on an admin-only call.
- After rotation, a single leaked key can't call any admin function.
- `docs/KEYS.md` lists the signers, thresholds, and who holds each key.
- The deployer's secret key isn't in any production environment.

## Risks

- Lost keys. If two of three are lost, the contracts can't be administered at all. Keep a documented recovery path, and keep the keys with different people.
- Breaking the account if the steps are done in the wrong order. The spike exists to catch this.

## Spike result (testnet)

**Passed.** `scripts/spike/multisig-admin.mjs`, run against a fresh compliance contract whose admin was a throwaway account:

| Case | Result |
|---|---|
| Single signature, before conversion | Succeeds |
| Admin key alone, after conversion | Rejected at preflight (`Auth InvalidAction`) |
| One signer, after conversion | Rejected at preflight (`Auth InvalidAction`) |
| Two signers, after conversion | Succeeds on-chain |

Thresholds read back from Horizon: low, medium, and high all 2. Three signers at weight 1, master at weight 0.

Two findings that change the plan:

1. **The contracts README was wrong.** Its deploy command passed `--admin` as a constructor argument, but these contracts have no constructor. A deployed contract without `initialize` rejects every admin call with `NotInitialized`. The README is fixed.
2. **Multisig authorization must use the SDK's V2 path.** A hand-built legacy preimage was rejected. The `authorizeEntry` builder signs the correct payload, and the authorization must be re-simulated after signing.

Still needed before the real deployer is converted: three signer keys, each held by a different person, and the runbook in [docs/KEYS.md](../KEYS.md) followed on testnet first.

