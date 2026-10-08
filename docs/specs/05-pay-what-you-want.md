# Spec 5: Pay-what-you-want links

**Status:** decision needed, on whether to build it and with which limits.
**Priority:** low. It's a feature, not a fix.

## What the code does today

A link with no `amount_usdc` is an open-amount link. `loadPayableLink` refuses it: "pay-what-you-want links need an amount param (not yet implemented)". The reconciler's verdict also holds any payment against such a link as `no_fixed_amount`, because it can't be checked.

## Why it's more than a UI change

The reconciler checks every payment against the amount the session reserved. A PWYW payment has no fixed amount, so the session has to record the amount the payer chose, at reserve time, and the verdict has to check the payment against that recorded amount.

That means the amount is set in two places that must agree: the payer's choice, and the session's record of it. If the session records one amount and the payer pays another, the verdict holds the payment, which is the correct outcome.

## Options

**A. Don't build it.** Fixed-price links cover the current use cases. Remove the open-amount path from the API so the code and the docs agree.

**B. Opt-in PWYW with a required minimum.** Merchant sets a minimum, and optionally a maximum. Payer enters an amount within the range. Fixed-price is still the default.

**C. Tips.** A fixed link plus an optional tip line at checkout. Simpler verdict logic: the link amount is checked as now, and the tip is a separate expected amount recorded on the session.

## Recommendation

**Option B, opt-in, with a required minimum and an optional maximum.** Keep fixed-price as the default. Don't build tips (C) unless merchants ask for it, because it's the same work with a more confusing checkout.

Set the minimum to at least one stroop-scale unit of the asset, and in practice to a few cents, so the fee floor (spec 1) never exceeds the amount.

## Decision needed

1. Build it at all: yes (B), no (A), or tips (C).
2. Minimum: per asset, or a single value in USD.
3. Maximum: required, optional, or none.
4. Whether the fee floor from spec 1 applies on top of a PWYW amount (recommendation: yes, the same rule as any payment).

## Build plan (once decided)

1. Migration: add `links.pay_what_you_want` (boolean), `links.min_amount`, and `links.max_amount`. Fixed links keep `amount_usdc` and set the new fields to null.
2. `POST /links` accepts a PWYW link with a minimum, and rejects one without.
3. `POST /links/:linkId/sessions` accepts an `amount` for PWYW links, checks it against the range, and records it on the session as `expected_amount`.
4. `prepareTx` and `buildPayUri` take the session's recorded amount, not the link's, when the link is PWYW.
5. Reconciler: the verdict compares against `link_sessions.expected_amount`, not `links.amount_usdc`. Fixed links are unchanged, because their session amount equals the link amount.
6. Checkout page: an amount field with the range shown, and the fee preview updated as the payer types.
7. Remove the "not yet implemented" error.

## Acceptance criteria

- A PWYW payment of an amount inside the range is recorded as `paid`, with the fee computed on that amount.
- An amount below the minimum or above the maximum is refused at reserve time, before any payment is made.
- A payment that doesn't match the amount recorded on the session is held as `amount_mismatch`, as fixed-price payments are today.
- Fixed-price links behave exactly as before.

## Risks

- The verdict is the place where a PWYW bug would turn into a money bug. Cover it with the same unit tests as fixed-price links, plus one test per boundary (minimum, maximum, just outside).
