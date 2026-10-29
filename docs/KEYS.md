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

## Admin rotation (updated 2026-10-25 — route 2 below has shipped)

`compliance`, `payment`, and `channel` each export `set_admin(current_admin, new_admin)` as of the M1 redeploy (`konfirm-contracts` commit `851fa1a`, see that repo's `README.md` for the live addresses) — confirmed present on all three via `stellar contract info interface --network testnet`. It requires **both** `current_admin.require_auth()` and `new_admin.require_auth()`, a two-party handshake: a leaked admin key alone cannot install a new admin the real admin never consented to, and the new admin can't be set without that new admin's own key actually signing. `treasury` has no `set_admin` — it has no single admin role to rotate; its 2-of-3 signer set governs settlements directly, and there's no `set_admin`-equivalent for replacing a signer today (a real gap, not yet closed — see below).

Nothing in this backend calls `set_admin` yet — it exists on-chain, unused. Rotating today means a manual `stellar contract invoke ... -- set_admin --current_admin <old> --new_admin <new>` for each of the three contracts, signed by both keys. Building this into the admin UI (alongside the treasury settlement tooling, PRD `docs/PRD.md` M2) is still open — not done in this pass.

The multisig-deployer route below is still a valid alternative/complement for any contract (including `treasury`, which has no `set_admin` route at all) — it works without touching contract code, by moving multi-signature enforcement onto the Stellar *account* itself rather than the contract's own storage.

1. **No redeploy: make the deployer account a multisig.** Stellar accounts can require several signatures. Set the deployer account's master weight to 0, add three signers (for example, three team members' hardware keys), and set the medium and high thresholds to 2. The admin `require_auth` then needs two signatures, not one leaked key. This works on the existing contracts. Do it with `stellar` CLI or Stellar Laboratory, using the current deployer key, before anything else. Then remove `STELLAR_DEPLOYER_SECRET_KEY` from the production environment entirely.
2. **`set_admin` (shipped for compliance/payment/channel).** Call it directly — no redeploy needed now that it's live. Still manual (no backend/UI call path) and still needs both the current and new admin's signatures in hand.

## Checklist, in order

1. Create the facilitator key in KMS (or generate a dedicated Stellar key), fund it, and set `FACILITATOR_KMS_KEY_ID` or `FACILITATOR_SECRET_KEY` in production.
2. Create or confirm a separate fee-account key. Set `PLATFORM_FEE_SECRET_KEY`.
3. Move the deployer account to a multisig (route 1 above), or rotate via `set_admin` (route 2, already live — no redeploy needed).
4. Remove `STELLAR_DEPLOYER_SECRET_KEY` from production. Confirm the service boots and signs a settlement.
5. Confirm `FACILITATOR_DAILY_SPEND_CAP_USDC` is set to a sensible value.
6. **Seed a compliance canary address and set `COMPLIANCE_CANARY_ADDRESS`** (backend#210). Immediately after the compliance contract's `initialize` call succeeds, `block_address` one throwaway address you control (it needs no funding — it's never used for anything but this check) and set `COMPLIANCE_CANARY_ADDRESS` to it in that environment. Without this step, `isAllowedOnChain()`'s success path has no way to tell "screening is genuinely running" from "the compliance contract is uninitialized or pointed at the wrong ID" — see `src/common/onchain-compliance.ts`'s `checkComplianceCanary()`. With it set, `/admin/blockchain/status`'s `complianceCanary` field reads `{ configured: true, ok: true }` in the healthy case; `ok: false` (and a `console.error('[compliance] CANARY BREACH'...)` line) means compliance screening itself may not be running, independent of any one payment's outcome. Skipping this step leaves the check silently disabled (`{ configured: false, ok: null }`), not failing — it will not page anyone on its own.

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

