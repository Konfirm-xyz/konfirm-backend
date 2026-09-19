import { BadRequestException, Injectable } from '@nestjs/common';
import { BASE_FEE, Horizon, Memo, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { resolveAsset } from '../common/asset';
import { fetchWithRetry, withRetry } from '../common/retry';

const FETCH_TIMEOUT_MS = 10_000;

// Stellar's own reference/demo anchor — SEP-1 discovery at
// https://testanchor.stellar.org/.well-known/stellar.toml confirms it speaks
// SEP-10 (auth) and SEP-24 (interactive withdraw) against the exact same
// testnet USDC issuer Konfirm already uses. This is a real protocol
// integration against a real (if test-mode) anchor, not a stand-in — the
// same code would point at a production anchor's endpoints unchanged.
const WEB_AUTH_ENDPOINT = 'https://testanchor.stellar.org/auth';
const TRANSFER_SERVER = 'https://testanchor.stellar.org/sep24';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';

interface WithdrawTransaction {
  status: string;
  amount_in?: string;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: string;
  message?: string;
}

@Injectable()
export class WithdrawalsService {
  private horizon = new Horizon.Server(HORIZON_URL);

  // SEP-10 step 1: the anchor hands back a challenge transaction (sequence
  // number 0, never submitted to the network) that only the account holder
  // can meaningfully sign — Konfirm never holds that key, so this always
  // has to round-trip through the merchant's own wallet. A GET with no
  // side effects — safe to retry freely (fetchWithRetry only retries
  // transport failures and 5xx; a 4xx here always means the same thing
  // twice, so it's returned immediately).
  async getChallenge(account: string) {
    const res = await fetchWithRetry(`${WEB_AUTH_ENDPOINT}?account=${encodeURIComponent(account)}`, {}, { timeoutMs: FETCH_TIMEOUT_MS });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadRequestException(body.error || 'could not reach the cash-out partner');
    return body;
  }

  // SEP-10 step 2: hand the merchant-signed challenge back to the anchor in
  // exchange for a session JWT scoped to that account. One retry only —
  // re-submitting the same already-signed challenge is safe (the anchor
  // either issues the token again or rejects a used one), but this is a
  // POST, so it doesn't get the same free retry budget as a plain read.
  async exchangeToken(signedTransaction: string) {
    const res = await fetchWithRetry(
      WEB_AUTH_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: signedTransaction }),
      },
      { retries: 1, timeoutMs: FETCH_TIMEOUT_MS },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadRequestException(body.error || 'the cash-out partner rejected that signature');
    return body;
  }

  // SEP-24 step 1: opens an interactive session. The anchor hands back a
  // URL to its own hosted UI (bank details, test KYC) — Konfirm never sees
  // or stores any of that.
  //
  // Deliberately no retry here, unlike the reads above: this POST creates a
  // new transaction on the anchor's side every time it succeeds. If the
  // first attempt actually landed and only the response was lost in
  // transit, blindly retrying would leave an orphaned duplicate transaction
  // behind — a timeout still fails fast, it just doesn't self-heal.
  // EURC resolves fine through resolveAsset() below (checkout's link
  // currency and this cash-out currency happen to share that helper), but
  // testanchor.stellar.org's own SEP-24 /info only lists `native`/USDC/SRT
  // as withdrawable assets (confirmed live) — the cashout page's currency
  // toggle deliberately stays XLM/USDC-only rather than offering a EURC
  // option that would fail at the anchor, not because of a gap on this
  // side.
  async startWithdrawal(token: string, currency: string, account: string) {
    const assetCode = currency === 'XLM' ? 'native' : currency;
    // The spec (SEP-24) allows form-encoded, multipart, or JSON bodies here
    // — this particular anchor only actually accepts JSON in practice,
    // confirmed directly against testanchor.stellar.org rather than assumed
    // from the spec's permissive wording.
    const res = await fetch(`${TRANSFER_SERVER}/transactions/withdraw/interactive`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ asset_code: assetCode, account }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadRequestException(body.error || 'could not start a cash-out');
    return body;
  }

  // A read, polled repeatedly anyway by the caller — safe to retry within a
  // single poll rather than waiting a full extra interval on a blip.
  async getStatus(token: string, id: string): Promise<WithdrawTransaction> {
    const res = await fetchWithRetry(
      `${TRANSFER_SERVER}/transaction?id=${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${token}` } },
      { timeoutMs: FETCH_TIMEOUT_MS },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadRequestException(body.error || 'could not check cash-out status');
    return body.transaction;
  }

  // Once the anchor's hosted flow reaches pending_user_transfer_start, it
  // hands back exactly where to send funds (account + memo) and how much.
  // Konfirm builds that payment the same way checkout builds one — for the
  // merchant's own wallet to sign. No new custody model here either.
  async prepareWithdrawalTx(account: string, currency: string, txn: WithdrawTransaction) {
    if (!txn.withdraw_anchor_account || !txn.withdraw_memo || !txn.withdraw_memo_type || !txn.amount_in) {
      throw new BadRequestException('the cash-out partner has not confirmed transfer details yet');
    }
    const asset = resolveAsset(currency);
    // A read, safe to retry — same reasoning as payments.service.ts.
    const sourceAccount = await withRetry(() => this.horizon.loadAccount(account), { retries: 2, timeoutMs: 8_000 });

    let memo: Memo;
    if (txn.withdraw_memo_type === 'id') {
      memo = Memo.id(txn.withdraw_memo);
    } else if (txn.withdraw_memo_type === 'hash') {
      memo = Memo.hash(Buffer.from(txn.withdraw_memo, 'base64'));
    } else {
      memo = Memo.text(txn.withdraw_memo);
    }

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: txn.withdraw_anchor_account,
          asset,
          amount: txn.amount_in,
        }),
      )
      .addMemo(memo)
      .setTimeout(60)
      .build();

    return { xdr: tx.toXDR(), network_passphrase: Networks.TESTNET };
  }
}
