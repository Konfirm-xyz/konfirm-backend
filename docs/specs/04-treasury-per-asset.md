# Spec 4: Per-asset treasury

**Status:** decision needed, on which assets to sweep and who signs.
**Priority:** medium. Fee revenue in XLM and EURC accumulates on the fee account and isn't swept.

## The problem

The treasury contract takes one token, at `initialize`:

```rust
pub fn initialize(env: Env, admin: Address, token: Address, signers: Vec<Address>, threshold: u32)
```

The fee sweep moves only USDC, into the single treasury instance. XLM and EURC fees pile up on the fee account, with no custody and no sweep.

## Options

**A. Deploy one treasury instance per asset, from the existing contract (no code change).** Each instance is initialized with a different token: USDC, EURC, and the native XLM SAC. The backend keeps a map from asset to treasury id, and the sweep chooses the right one.

**B. Change the contract to hold multiple tokens.** The contract would keep a balance per token, and settlements would name the token. More flexible, but it's a contract change, needs an audit, and a redeploy of the one instance that holds funds.

**C. Sweep everything to one non-contract account, controlled by a multisig.** Simplest. But it moves custody out of the treasury design we've already tested, and removes the on-chain approval step for those funds.

## Recommendation

**Option A.** It needs no contract change, reuses the code we've already tested and deployed, and keeps the two-of-three approval for every asset. Each treasury instance is the same tested code with a different token.

Trade-offs to accept:
- Each instance has its own signer set and threshold. Keep the same signers, so approvals don't multiply.
- The number of instances grows with the number of assets. That's fine for three assets.
- XLM needs its native SAC. Check that the SAC address for native XLM is the one the treasury's `token::TokenClient` expects. It should be, but verify in the spike.

## Decision needed

1. Which assets to sweep: USDC only (status quo), USDC and EURC, or all three including XLM.
2. Signers for the new instances: the same three as the USDC instance (recommended), or a different set.
3. Whether to ever sweep XLM, given that XLM is volatile and the treasury holds it until settlement. (Recommendation: yes, but settle it to USDC on a schedule, as a separate step, so the treasury doesn't hold a volatile asset.)

## Build plan

1. **Deploy** the existing `treasury` WASM once per asset, with the same signers and threshold. Record each id in `konfirm-contracts/README.md` and in the backend's config (`TREASURY_CONTRACT_ID` becomes a map: `{ USDC: …, EURC: …, XLM: … }`).
2. **Backend sweep:** `FeeCollectionSweepService` currently sweeps one asset to one treasury. Change it to sweep each asset to its own treasury, with the same spend guard applied to each sweep.
3. **Admin treasury page:** show balances per asset.
4. **Migration of the existing USDC instance:** none needed. It stays as it is.
5. **Settlement of XLM to USDC:** a separate, later decision. Out of scope for this spec.

## Acceptance criteria

- The sweep moves USDC, EURC, and XLM fee balances above their operating minimums, each into its own treasury instance.
- Each sweep goes through `execute_settlement` with two approvals, as the USDC sweep does today.
- The spend guard counts all three assets against the daily cap, in USD.
- `konfirm-contracts/README.md` lists every treasury instance and its token.

## Risks

- A bug in the per-asset map would send an asset to the wrong treasury. Test with a dry run on testnet for each asset before enabling.
- XLM balances on the fee account must keep the account's minimum reserve. The sweep has to leave the reserve in place.
