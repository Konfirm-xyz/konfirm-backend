# Spec 1: Pricing model

**Status:** mechanics done, values pending your decision.

Done: the fee rule is one function in each language (`src/common/money-rules.ts`, `reconciler/src/money.rs`), checked against shared golden vectors (`money-rules/vectors.json`). Checkout and the fee preview use it. A floor exists, set by `PLATFORM_FEE_FLOOR` (asset units), and is off by default, so behaviour is unchanged.

Still to decide: the rate for new merchants, the floor value, and whether existing merchants move.
**Owner:** you (product).

## The question

Konfirm charges a platform fee of 10 basis points (0.10%) per payment, by default. At that rate, $10,000 of volume earns $10, and $1,000,000 earns $1,000. Before the rate is set, we need to know whether that is the right model.

## What the code does today

- `merchants.fee_bps` defaults to 10 (migration 001). `effective_fee_bps` applies a referral promo on top: the referee pays 0% for 30 days or $500, and the referrer gets half-price for 30 days.
- The fee is recorded per payment in `payments.fee_usdc`, and is collected as an extra operation on Freighter checkout. On QR, it's owed and settled by the merchant (Option B).
- There is no subscription, no minimum fee, and no fixed fee per payment.

## Options

**A. Keep per-transaction, raise the rate.** For example, 1.00%. Simple and aligned with volume. Risk: higher rates push merchants to competitors, and the "crypto payments are cheap" comparison is a strong sales objection.

**B. Per-transaction with a floor.** For example, 0.50% with a $0.05 minimum. The minimum covers the cost of small payments, which otherwise lose money once support time is counted.

**C. Subscription.** For example, $29 a month with a 0.25% rate, or $0 a month with 1.00%. Predictable revenue, and the QR problem disappears because the fee is no longer per payment. Risk: merchants with low volume pay more than they would per transaction.

**D. Gross-up.** The merchant sets the amount they want to receive, and the payer pays the amount plus the fee. Fees stay visible at checkout, and merchants don't see a deduction. Risk: it changes what the payer sees, and interacts with QR (the payer must pay the grossed-up amount).

## Recommendation

**1.00% per payment with a $0.05 floor, with the current 0.10% kept for existing merchants.**

Reasons:
- The base rate is far too low to cover support and infrastructure. At 0.10%, a merchant doing $5,000 a month pays $5. That isn't a business.
- A subscription is worth adding later, as a discount tier, but it should not be the only option. Small merchants will not sign up for a monthly fee they can't predict.
- Grandfathering protects the merchants already onboarded. Changing their rate without notice is the fastest way to lose the pilot.

I have not verified competitor pricing or your cost base. Treat 1.00% as a starting hypothesis, and check it against what the pilot merchants will actually pay before going live.

## Decision needed

1. Per-transaction rate for new merchants: 0.50%, 1.00%, or other.
2. Minimum fee per payment: none, $0.05, or other.
3. Subscription tier: none for now, or add now at a fixed monthly fee.
4. Existing merchants: keep 0.10%, or move to the new rate on a date.

## Build plan (once decided)

1. Migration: change the column default for new merchants, leave existing rows as they are (or set them explicitly to 10 bps for grandfathering).
2. Fee math: add a per-payment floor in `owed_fee` and in the Freighter fee leg (`prepareTx`). Both must apply the same rule.
3. Admin: a way to set a merchant's rate. Today no admin endpoint or page sets `fee_bps`, so a rate change means a direct database update.
4. Checkout copy: show the fee as it is charged.
5. If a subscription is chosen: a billing model, a plan field on `merchants`, and renewals. This is a separate build and needs its own spec.

## Acceptance criteria

- A payment of $10 at 1.00% with a $0.05 floor records a fee of $0.10.
- A payment of $0.01 records a fee of $0.05 (the floor), and the payer's total reflects it.
- Existing merchants keep 10 bps unless explicitly changed.
- Freighter checkout and the owed-fee settlement compute identical fees for the same payment.
