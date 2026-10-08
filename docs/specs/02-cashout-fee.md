# Spec 2: Cash-out fee

**Status:** blocked on the anchor spike.

The spike needs a real SEP-24 interactive withdrawal, and the test anchor's flow requires a person to complete a form in a browser. It can't be run headless from here. Until it's run, no cash-out fee code is written, so nothing can change a withdrawal by accident.
**Owner:** you (product). The anchor's terms also need checking.

## The question

Merchants cash out to a bank through the SEP-24 anchor. Konfirm earns nothing on that step, so the only platform revenue is the payment fee. Should Konfirm charge a cash-out fee, and how much?

## What the code does today

`WithdrawalsService.preparePayment` builds one transaction: a single payment of `amount_in` from the merchant's account to the anchor, with the anchor's memo. The merchant signs it in Freighter. There's no fee operation.

## Why this is easier than it looks

A fee can be added to that same transaction as a second payment operation, paying the fee account from the merchant's balance. The merchant signs once, and the fee and the cash-out settle atomically. This is the one place where the atomic two-leg form works without any new trust assumption, because the merchant is the payer and the merchant is always known.

The risk is the anchor. The anchor sees a payment of `amount_in` to its account with its memo. An extra operation to a different account is normally fine, but the anchor's own checks decide it, and we have not tested this. That's the first step of the build.

## Options

**A. No cash-out fee (status quo).** Simple. Revenue comes only from payments.

**B. Flat fee per cash-out.** For example, $1 per cash-out. Predictable, and easy to explain. Hurts small cash-outs most.

**C. Percentage with a minimum.** For example, 1.00% with a $1 minimum. Scales with value, and the minimum keeps small cash-outs from being free.

**D. Included in the payment fee.** No separate cash-out fee, but the payment rate is raised. Simpler for merchants. Harder to see what cash-out costs.

## Recommendation

**Option C: 1.00% with a $1 minimum, collected as a second operation in the same signed cash-out transaction.**

- Atomic with the cash-out, so there's no separate settlement to chase.
- Visible, so merchants can see what they're paying.
- Doesn't change the payment rate, so the two decisions are independent.

If you adopt the pricing recommendation in spec 1, the total cost for a merchant becomes: 1.00% on each payment, plus 1.00% on the cash-out. That's roughly 2% end to end. Check that against what pilot merchants will accept before you commit.

## Decision needed

1. Charge a cash-out fee at all: yes or no.
2. Model: flat, percentage with minimum, or included in payment fee.
3. Amount: for example, 1.00% and a $1 minimum.
4. Waiver: first cash-out free, or none.

## Build plan (once decided)

1. **Spike, before anything else (half a day):** on testnet, use the existing SEP-24 test anchor (`testanchor.stellar.org`). Add a second payment operation to the prepare-payment transaction, and confirm the anchor still completes the withdrawal. If it rejects, the fee has to be collected another way (a separate merchant-signed settlement, as with payment fees).
2. Fee calculation in one function, used by both the API and the UI, with the same rounding rule as payment fees (round down to a stroop).
3. `prepare-payment` returns the fee in its response, so the UI can show it before signing.
4. Store the fee on the withdrawal attempt, so admins can see fees collected per cash-out.
5. Admin revenue view includes cash-out fees, separated from payment fees.

## Acceptance criteria

- The spike shows the anchor completes a withdrawal whose transaction carries an extra fee operation.
- A $200 cash-out at 1.00% with a $1 minimum charges $2.00. A $50 cash-out charges $1.00 (the minimum).
- The merchant sees the fee in the preview and in Freighter's transaction summary before signing.
- If the anchor's amount limits don't allow the fee, the cash-out is refused with a clear message, not silently reduced.
