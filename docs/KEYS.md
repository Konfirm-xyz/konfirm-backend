# Keys: who holds what, and how to split them

Four identities matter. Keep them separate.

| Identity | Env var | Can do | Blast radius if leaked |
|---|---|---|---|
| Facilitator (hot) | `FACILITATOR_KMS_KEY_ID` or `FACILITATOR_SECRET_KEY` | Sign x402 settlements, channel submissions, sweeps. Capped by the daily spend guard | Drains the facilitator float, up to the daily cap |
| Fee account | `PLATFORM_FEE_SECRET_KEY` | Sweep accumulated fee USDC into the treasury | Moves fee revenue. The treasury contract still needs its own approval flow |
| Deployer | `STELLAR_DEPLOYER_SECRET_KEY` (only needed for deploys, and in non-production dev) | Admin of compliance, payment, and channel contracts. One of three treasury signers | Contract admin: can block or unblock addresses, pause, and reroute. Plus one treasury signature (2 of 3 needed to move funds) |
| Treasury signers (2 others) | not in this service | Approve treasury settlements | Need two of three to move funds |

## What the code enforces

- The facilitator never falls back to the deployer key in production. Production needs `FACILITATOR_KMS_KEY_ID` or `FACILITATOR_SECRET_KEY`, or it throws on the first signing attempt.
- At boot, `assertSeparateHotKeys()` refuses to start if the deployer, facilitator, and fee secrets resolve to the same account (`src/common/facilitator-signer.ts`).

## What the code cannot fix: the deployer is the contract admin

The contracts have no admin rotation. `compliance`, `payment`, and `channel` take the admin address once, in `initialize`, and no function changes it. Two routes:

1. **No redeploy: make the deployer account a multisig.** Stellar accounts can require several signatures. Set the deployer account's master weight to 0, add three signers (for example, three team members' hardware keys), and set the medium and high thresholds to 2. The admin `require_auth` then needs two signatures, not one leaked key. This works on the existing contracts. Do it with `stellar` CLI or Stellar Laboratory, using the current deployer key, before anything else. Then remove `STELLAR_DEPLOYER_SECRET_KEY` from the production environment entirely.
2. **Redeploy with an admin-rotation function.** Add `set_admin` to each contract, deploy new instances, and update the addresses in `konfirm-contracts/README.md`, `konfirm-backend`'s compliance client, and the reconciler. This is the cleaner long-term answer and costs a redeploy.

## Checklist, in order

1. Create the facilitator key in KMS (or generate a dedicated Stellar key), fund it, and set `FACILITATOR_KMS_KEY_ID` or `FACILITATOR_SECRET_KEY` in production.
2. Create or confirm a separate fee-account key. Set `PLATFORM_FEE_SECRET_KEY`.
3. Move the deployer account to a multisig (route 1 above), or plan the redeploy (route 2).
4. Remove `STELLAR_DEPLOYER_SECRET_KEY` from production. Confirm the service boots and signs a settlement.
5. Confirm `FACILITATOR_DAILY_SPEND_CAP_USDC` is set to a sensible value.

## Converting the deployer to a 2-of-3 multisig (runbook)

**Verified on testnet** with throwaway accounts: `scripts/spike/multisig-admin.mjs`. Before conversion a single signature authorizes an admin call. After conversion the admin key alone is rejected, one signer is rejected, and two signers succeed. The thresholds were read back from Horizon.

Run it on a new account first, then on the real deployer on testnet. Only then mainnet.

1. **Before anything else**: record the current deployer's signers and thresholds (Horizon `/accounts/<deployer>`). Keep the output.
2. **Generate the three signer keys on three separate devices, held by three people.** Never generate them on the same machine as the deployer key, and never give two signers to one person.
3. **Add the signers and set thresholds to 2**, in one transaction signed by the deployer alone. Master weight stays 1 at this step, so the deployer can still sign the next step.
4. **Set the master weight to 0**, in a transaction signed by the deployer *and* one of the new signers. The high threshold is 2, so the deployer alone can't make this change. Doing it in the other order locks the account.
5. **Verify** (testnet first): an admin call with the deployer key alone is rejected, one signer is rejected, and two signers succeed. The spike script shows the exact construction of each authorization.
6. **Remove** `STELLAR_DEPLOYER_SECRET_KEY` from every environment. Keep `DEPLOYER_ADDRESS` (public).
7. **Record** the signers and thresholds in this file, and where each key is held.

Warnings:
- The authorization must be built with the SDK's `authorizeEntry`, not hand-built. The protocol uses the V2 address-bound preimage (CAP-71), and a hand-built legacy preimage is rejected.
- A signed authorization changes the footprint. Re-simulate after signing, then build the final transaction.
- If two of the three signers are lost, the contracts can't be administered. Keep the keys with different people, and keep a recovery plan.

