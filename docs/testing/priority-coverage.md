# Priority coverage plan: links, sessions, payments, deposits

Status: four specs now exist under `src/{payments,links,sessions,deposits,withdrawals}`:
`src/deposits/testnet-faucet.guard.spec.ts`, `src/payments/payment-attestation.service.spec.ts`,
`src/payments/payments.controller.spec.ts`, and `src/links/links.service.spec.ts`.
Sessions, withdrawals, and most of `PaymentsService`'s business logic remain uncovered.
This document lists the specs to write first, ordered by risk, so the next test PR starts from
the riskiest branches rather than happy paths. It does not add tests itself.

## Acceptance bar

Each function below gets at least one spec that exercises its primary edge case, not only the
happy path. Where a known gap exists, the spec should pin the current behaviour and reference the
finding, so a fix flips the assertion deliberately.

## 1. `PaymentsService.prepareTx` (`src/payments/payments.service.ts`)

Cases:
- Link not found, inactive, expired: each throws the matching HTTP exception from `loadPayableLink`.
- Zero or null `amount_usdc` (pay-what-you-want): throws the "not yet implemented" BadRequest.
- Merchant with no `stellar_base_address`: throws BadRequest.
- Merchant `status` other than `active` (suspended): throws BadRequest.
- Blocked payer (`isPayerAllowed` returns false): throws Forbidden before any XDR is built.
- Native XLM vs non-native (USDC) asset: trustline-bundling branch differs.
- Fee = 0 vs fee > 0: fee-bundling branch differs.

## 2. `PaymentsService.buildPayUri` (`src/payments/payments.service.ts`)

Cases:
- Native asset: no `asset_code` / `asset_issuer` parameters.
- Non-native asset: both `asset_code` and `asset_issuer` present and URL-encoded.
- `memo` is the muxed id with `memo_type=MEMO_ID`.
- Same `loadPayableLink` rejections as `prepareTx`. The fee-bypass finding filed separately
  depends on whether these rejections also apply on this path; a spec should decide that.

## 3. `LinksService.create` (`src/links/links.service.ts`)

Cases:
- Amount omitted (`amount_usdc` null, stored as pay-what-you-want): the row is inserted with a null
  amount, and `loadPayableLink` rejects it at payment time. A `0` amount is stored as `0`, not
  null, so it takes a different path; the spec should pin which one happens.
- Idempotency: a repeated `idempotency_key` for the same merchant returns the original row, not a
  second link.
- Defaults: `currency` falls back to `USDC`, `reusable` to `true`.

## 4. `SessionsService.reserve` (`src/sessions/sessions.service.ts`)

Cases:
- Unknown link: NotFound.
- Inactive link: Conflict.
- Known gap: the check only reads `active`. It does not check link expiry or suspended-merchant
  status, so a reservation can be created for an expired link or a suspended merchant. A spec
  should document this current behaviour.
- `muxed_id` collision (Postgres `23505` on `UNIQUE(merchant_id, muxed_id)`): Conflict with the
  "regenerate the nonce" message. Any other DB error is rethrown unchanged.

## 5. `DepositsService.prepareTransferPayment` (`src/deposits/deposits.service.ts`)

Cases:
- Native XLM: no trustline lookup on the destination.
- Non-native asset, destination has the trustline: no ChangeTrust bundled.
- Non-native asset, destination has no trustline: ChangeTrust is bundled.
- Destination not found: the lookup is not retried and the error surfaces directly.
- Sender lookup is retried (`retries: 2`).

## 6. `PaymentAttestationService.attest` (`src/payments/payment-attestation.service.ts`)

Cases:
- Success: returns `onchainPaymentId` and the transaction hash.
- Contract error result: returns `success: false` with `contract_error_<message>`.
- Thrown RPC error: logged, and the cached client is reset; the error does not escape as success.
- Amount conversion: `netUsdc` is converted to stroops with `Math.round`. Pin rounding at a
  fractional-stroop boundary.

## 7. `PaymentAttestationSweeperService.doSweep` (`src/payments/payment-attestation-sweeper.service.ts`)

Cases:
- Merchant with no `stellar_base_address`: row is skipped, not attested, and a warning is logged.
- `attest` returns `success: false`: row is left unattested (`attested_at` stays null).
- `attest` succeeds: `onchain_payment_id` and `attested_at` are written back.
- One row throwing does not stop the rest of the batch.

## Ordering

1. `prepareTx` and `buildPayUri`, because they sit on the payment path and share `loadPayableLink`.
2. `SessionsService.reserve`, for the expiry and suspension gap.
3. `PaymentAttestationService.attest` and `doSweep`.
4. `LinksService.create` and `DepositsService.prepareTransferPayment`.

## Test setup notes

- `jest.config.js` runs `src/**/*.spec.ts` in the `fast` project, which blocks CI. Unit specs for
  these services must not hit Horizon, Soroban RPC, or Friendbot. Mock those clients.
- Database-backed behaviour (idempotency, `23505` collisions) belongs in `test/*.e2e-spec.ts`
  against Postgres, not in unit specs.
