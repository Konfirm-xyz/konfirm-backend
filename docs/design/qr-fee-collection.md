# Collecting the checkout fee on QR / mobile-wallet payments

Status: Option B (merchant-signed fee settlement) is implemented. Option A is ruled out, per the testnet spike below.

## The problem

- Every merchant defaults to a 10 bps (0.10%) fee, added on top of the link amount and paid by the payer as a second payment operation in the same transaction (`payments.service.ts` `prepareTx`).
- The QR / SEP-7 path (`buildPayUri`) can only express one payment: destination, amount, asset, memo. The fee leg can't be carried.
- The checkout page therefore hides QR whenever a fee applies (`pay/[linkId]/page.tsx`). With the default fee, that is every link. Mobile-wallet payers can only use Freighter, which is effectively desktop-only.
- Separately, the reconciler records a payment as `paid` even when the fee leg is missing, so the fee is only collected when the honest client builds it.

Two things need fixing: the fee should be atomic with the merchant's payment, and mobile payers need a way to pay.

## Constraints

- A Stellar classic transaction has one source account and one sequence number. The source must sign, and so must every operation's source account.
- SEP-7 `pay` builds the transaction inside the wallet, so it can't add a second operation. SEP-7 `tx` takes a complete, pre-built transaction XDR. That is the only SEP-7 route that can carry two legs.
- Pre-built transactions need a fixed sequence number. Two unsigned transactions sharing one sequence number can't both submit, which is the same problem the facilitator's submission queue solves.

## Option A: sponsored two-leg transaction. Tested on testnet, not viable for QR

The idea was: the platform is the transaction source (fixing the sequence number and paying the fee), the payer is the source of both payment operations, and the wallet signs as the payer. The spike in `scripts/spike/sponsored-two-leg.mjs` tested this on testnet with throwaway accounts:

| Case | What happened | Meaning |
|---|---|---|
| A. Payer known to the server when the transaction is built, sponsor and payer both sign | Success. Both legs landed in one ledger | The atomic two-leg form works |
| B. Server builds with a placeholder in the payer's slots, sponsor signs, wallet substitutes its own account (SEP-7 `replace`) | `tx_failed`, `op_bad_auth` | The sponsor's signature covers the placeholder, so substitution invalidates it |
| C. Wallet adds only the payer's signature (the wallet holds no sponsor key) | `tx_bad_auth` | The sponsor signature is required, and the wallet can't produce it |

SEP-7 `replace` can rewrite the source account and operation sources, but the spec doesn't let a wallet fix the sequence number either. So a QR scan can't yield an atomic two-leg transaction: the sponsor has to sign after the server learns the payer's address, and a QR scan doesn't reveal it.

The only atomic variant is to learn the payer's address before building. That needs a connection step, such as WalletConnect or a wallet-kit `getAddress` call, which mobile wallets may or may not support. It's an untested integration and needs a wallet spike.

Freighter checkout already has this property (the payer is known, and the transaction is atomic), so nothing changes there.

## Option B (implemented): merchant-signed fee settlement

- Payers pay the link amount exactly, so QR and every mobile wallet work for every link.
- The reconciler records each QR payment's fee as owed (`fee_status = 'owed'`), with the fee computed from the merchant's effective rate at payment time. Payments that did include the fee leg stay `collected`.
- The merchant clears owed fees from the dashboard. The backend builds one transaction, paying the owed total per asset from the merchant's own account to the fee account. The merchant signs it in Freighter. Konfirm never holds the merchant's key, so this stays non-custodial.
- The backend confirms the settlement on Horizon by hash, checks the amounts, and marks those payments `collected`.
- Enforcement is visible but not automatic: owed fees appear on the dashboard and the admin page, and an admin can suspend an account that stays in arrears. An automatic cash-out block is a possible later step.
- Trade-off: a merchant who never settles keeps the fee owed. Enforcement depends on that visibility and on suspension, not on the payment itself.

Cash-out variant (not chosen): add the owed fee as a second operation in the existing cash-out transaction the merchant already signs. Fewer steps for the merchant, but nothing is collected until they cash out.

## Option C: change the pricing model

- Replace the per-transaction fee with a flat monthly plan. No fee leg is needed, QR works everywhere, and revenue no longer depends on payment volume. Worth weighing, since 0.10% of processed volume is small revenue.
- Or show a merchant-paid gross-up price (merchant sets a net amount and the link displays net plus fee). That changes what payers see and needs a product decision.

## Recommendation (revised)

1. Build Option B (fee settlement) for QR payments. Payers pay the link amount exactly, so QR works for every link. Fees accrue as owed, and the merchant clears them with one signed transaction, which is non-custodial.
2. Separately, spike the connect-first variant (WalletConnect or a wallet-kit address call) only if you want the fee to be atomic on QR. Its wallet support is unknown.
3. Decide whether the 0.10% base fee is the right business model (Option C). That affects revenue more than any of the wallet work.

## Open questions

- Which fee model do you want: per-transaction (A or B), flat subscription (C), or a mix?
- Is it acceptable for the platform to pay Stellar network fees on sponsored transactions? (Small, but recurring.)
- Which wallets matter most for your merchants?
