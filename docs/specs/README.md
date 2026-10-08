# Build specs: decisions still open

Each spec states the question, the options, a recommendation, the decision you need to make, the build plan once decided, and acceptance criteria. Nothing here changes code or deploys anything until you pick an option.

| # | Spec | Decision needed | Recommendation | Blocks |
|---|---|---|---|---|
| 1 | [Pricing model](01-pricing.md) | Per-transaction rate, minimums, subscription | 1.00% per payment, with a $0.05 floor, and a grandfathered 0.10% for existing merchants | Revenue |
| 2 | [Cash-out fee](02-cashout-fee.md) | Charge at cash-out, and how much | Yes: 1% in the same signed transaction, with a $1 minimum | Revenue |
| 3 | [Deployer as contract admin](03-deployer-admin.md) | Multisig now, or redeploy with `set_admin` | Multisig now (no redeploy), then `set_admin` in the next contract version | Key security |
| 4 | [Per-asset treasury](04-treasury-per-asset.md) | Which assets to sweep, and who signs | One treasury instance per asset, deployed from the existing contract (no code change) | Fee custody |
| 5 | [Pay-what-you-want links](05-pay-what-you-want.md) | Allowed, with what minimum and maximum | Opt-in per link, with a required minimum and an optional maximum | Feature |
| 6 | [Mainnet](06-mainnet.md) | Go-live values, audit, and the pilot plan | Audit first, then invite-only pilot with caps | Launch |
| 7 | [Comment style](07-comment-style.md) | Accept the style rule and cleanup scope | Adopt the rule, clean up one directory per PR | Maintainability |

## Order I'd take them

1. **Deployer multisig (3)**: a security issue, and it needs no decision beyond who holds the keys.
2. **Pricing (1) and cash-out fee (2)**: decide together, because they set the revenue model.
3. **Per-asset treasury (4)**: fixes fee custody, with no contract change.
4. **Mainnet (6)**: after the audit, and after 1 to 4.
5. **PWYW (5)** and **comment style (7)**: when there's capacity.

## Target architecture

The design these specs fit into, including the money core, ledger, signing boundary, and migration order, is in [docs/architecture/target-architecture.md](../architecture/target-architecture.md). A separate pass over process topology, coupling, and test architecture is in [docs/architecture/system-design-audit.md](../architecture/system-design-audit.md).
