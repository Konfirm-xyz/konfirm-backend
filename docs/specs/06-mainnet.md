# Spec 6: Mainnet

**Status:** decision needed, and several items need work outside this repo.
**Priority:** gating for any real money.

## Where we are

- `STELLAR_NETWORK=mainnet` is supported by the code. The backend loads every identifier it depends on from the environment, and refuses to boot until they're all set (`src/common/stellar-network.ts`, `missingForNetwork`).
- The reconciler reads the same issuer and contract variables.
- **Mainnet has never been run.** There are no mainnet contracts, no mainnet issuer values in this repo, and no test against mainnet. Setting the variables makes the process start, which is not the same as the system working.

## What mainnet needs

**Values** (set as environment variables, never committed):

| Variable | What it is | Source |
|---|---|---|
| `USDC_ISSUER`, `EURC_ISSUER` | Mainnet issuer accounts | Circle's published mainnet issuer addresses. Verify against Circle's docs, don't copy from a tutorial. |
| `USDC_SAC_ID` | Mainnet USDC token contract | Deploy or look up the SAC for the mainnet issuer |
| `X402_USDC_ADDRESS` | Same USDC token contract, as x402 expects it | Must match `USDC_SAC_ID` |
| `COMPLIANCE_CONTRACT_ID`, `PAYMENT_CONTRACT_ID`, `TREASURY_CONTRACT_ID`, `CHANNEL_CONTRACT_ID` | Our contracts on mainnet | Deployed by us, after the audit (below) |
| `DEPLOYER_ADDRESS`, `FACILITATOR_ADDRESS` | Mainnet accounts, with the key work from spec 3 done | Our accounts |
| `TREASURY_SIGNERS` | Three mainnet signer keys, two needed to approve | Spec 3 |
| `ANCHOR_AUTH_URL`, `ANCHOR_TRANSFER_SERVER` | A mainnet SEP-24 anchor | A licensed partner anchor. The testnet anchor isn't a production option. |

**Work outside this repo:**

1. **Security audit of the four contracts.** They hold funds (treasury, channel) and control compliance (compliance). They have not been audited. This is the largest item. Budget for it, and do not put mainnet funds into the contracts before it's done.
2. **Deployment.** A funded mainnet deployer, the contracts deployed, `initialize` run with the mainnet values, and the addresses recorded.
3. **Legal and compliance review.** The non-custodial design, cash-out through an anchor, and the fee model all need a view from counsel on money-transmission rules in each market you serve. I can't give that view, and this spec doesn't either.
4. **Anchor agreement.** SEP-24 flows on mainnet go through a partner that does KYC. We don't.

## Recommendation: staged launch

1. **Audit first.** No mainnet deployment before the audit's findings are fixed.
2. **Invite-only pilot.** A short list of merchants, each with a per-payment cap and a per-day cap. The facilitator spend cap (`FACILITATOR_DAILY_SPEND_CAP_USDC`) is already in code and should be set low.
3. **Monitoring.** The reconciler watchdog (already built) pages on a stalled cursor. Add alerts for any held payment with an amount above the pilot cap, and for any owed-fee balance above a threshold.
4. **Widen only after two weeks** of pilot traffic with no unexplained holds.

## Decision needed

1. Audit firm and budget.
2. Pilot list and caps.
3. Mainnet anchor partner.
4. Timing: whether mainnet waits for the pricing and fee decisions (specs 1 to 4), which I recommend.

## Build plan (code side, once the values exist)

1. Run the backend and reconciler on a mainnet-like environment (mainnet Horizon, but with a test account and no real contracts) to check the boot path and the env wiring.
2. Add a mainnet smoke test: fund a test account on mainnet with a very small amount, run one payment through the reconciler, and check the verdict.
3. Add a startup log line with the network and the contract ids, so a misconfigured deploy is visible in the logs.
4. Confirm `FACILITATOR_KMS_KEY_ID` is set and used on mainnet. Never fall back to `FACILITATOR_SECRET_KEY` on mainnet without an explicit decision.

## Acceptance criteria

- The backend refuses to start on mainnet with any identifier missing (already true).
- A mainnet smoke payment of a few cents is recorded correctly, with the fee owed or collected as expected.
- Audit findings are closed or formally accepted in writing.
- The pilot caps are enforced in code, not only in documentation.
