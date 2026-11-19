import { BadRequestException, Injectable } from '@nestjs/common';
import { BASE_FEE, Memo, Operation, TransactionBuilder, Horizon } from '@stellar/stellar-sdk';
import { resolveAsset } from '../common/asset';
import { withRetry } from '../common/retry';
import { AnchorClient } from '../common/anchor-client';
import { startInteractiveOnce } from '../common/anchor-start-dedup';
import { ANCHOR_AUTH_URL, ANCHOR_TRANSFER_SERVER, HORIZON_URL, NETWORK_PASSPHRASE } from '../common/stellar-network';

interface WithdrawTransaction {
  status: string;
  amount_in?: string;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: string;
  message?: string;
}

// SEP-24 memo types the anchor may hand back. Anything else (including
// `text`, which Stellar's own SDK caps at 28 bytes) is rejected rather than
// guessed at.
const MEMO_ID_MAX = 18_446_744_073_709_551_615n; // uint64
const MEMO_TEXT_MAX_BYTES = 28;
const STELLAR_AMOUNT_SCALE = 7;
const STELLAR_AMOUNT_MAX = 9_223_372_036_854_775_807n; // int64 stroops

function buildWithdrawMemo(type: string, value: string): Memo {
  switch (type) {
    case 'id': {
      if (!/^\d+$/.test(value) || BigInt(value) > MEMO_ID_MAX) {
        throw new BadRequestException('the cash-out partner returned an invalid memo id');
      }
      return Memo.id(value);
    }
    case 'hash': {
      // SEP-24 hash memos are base64-encoded 32-byte values. Buffer's base64
      // decoder is lenient (it drops invalid characters), so round-trip the
      // value and require an exact match to catch malformed input.
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length !== 32 || decoded.toString('base64') !== value) {
        throw new BadRequestException('the cash-out partner returned an invalid memo hash');
      }
      return Memo.hash(decoded);
    }
    case 'text': {
      if (Buffer.byteLength(value, 'utf8') > MEMO_TEXT_MAX_BYTES) {
        throw new BadRequestException('the cash-out partner returned an invalid memo text');
      }
      return Memo.text(value);
    }
    default:
      throw new BadRequestException('the cash-out partner returned an unsupported memo type');
  }
}

function validateWithdrawAmount(value: string): string {
  if (!/^\d+(?:\.\d{1,7})?$/.test(value)) {
    throw new BadRequestException('the cash-out partner returned an invalid amount');
  }
  const [whole, fraction = ''] = value.split('.');
  const stroops = BigInt(whole) * 10n ** BigInt(STELLAR_AMOUNT_SCALE) + BigInt(fraction.padEnd(STELLAR_AMOUNT_SCALE, '0'));
  if (stroops <= 0n || stroops > STELLAR_AMOUNT_MAX) {
    throw new BadRequestException('the cash-out partner returned an invalid amount');
  }
  return value;
}

// Stellar's own reference/demo anchor — SEP-1 discovery at
// https://testanchor.stellar.org/.well-known/stellar.toml confirms it speaks
// SEP-10 (auth) and SEP-24 (interactive withdraw) against the exact same
// testnet USDC issuer Konfirm already uses. This is a real protocol
// integration against a real (if test-mode) anchor, not a stand-in — the
// same code would point at a production anchor's endpoints unchanged (see
// ANCHOR_AUTH_URL/ANCHOR_TRANSFER_SERVER in stellar-network.ts). See
// AnchorClient for the shared SEP-10/SEP-24 mechanics — deposits.service.ts
// uses the same client, the other direction.
@Injectable()
export class WithdrawalsService {
  private horizon = new Horizon.Server(HORIZON_URL);
  private anchor = new AnchorClient(
    { webAuthUrl: ANCHOR_AUTH_URL, transferServerUrl: ANCHOR_TRANSFER_SERVER },
    { partnerLabel: 'cash-out partner', actionNoun: 'cash-out' },
  );

  getChallenge(account: string) {
    return this.anchor.getChallenge(account);
  }

  exchangeToken(signedTransaction: string) {
    return this.anchor.exchangeToken(signedTransaction);
  }

  // EURC resolves fine through resolveAsset() below (checkout's link
  // currency and this cash-out currency happen to share that helper), but
  // testanchor.stellar.org's own SEP-24 /info only lists `native`/USDC/SRT
  // as withdrawable assets (confirmed live) — the cashout page's currency
  // toggle deliberately stays XLM/USDC-only rather than offering a EURC
  // option that would fail at the anchor, not because of a gap on this
  // side.
  // Deduped: a client retry of the same start returns the session already
  // minted rather than opening a second cash-out on the anchor.
  startWithdrawal(token: string, currency: string, account: string) {
    return startInteractiveOnce('withdraw', account, currency, token, () =>
      this.anchor.startInteractive('withdraw', token, currency, account),
    );
  }

  getStatus(token: string, id: string): Promise<WithdrawTransaction> {
    return this.anchor.getStatus(token, id) as Promise<WithdrawTransaction>;
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

    // The anchor's response is untrusted input: a malformed memo or amount
    // must fail here with a clear error rather than silently producing a
    // payment that sends funds to the wrong place or with the wrong memo.
    const memo = buildWithdrawMemo(txn.withdraw_memo_type, txn.withdraw_memo);
    const amount = validateWithdrawAmount(txn.amount_in);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: txn.withdraw_anchor_account,
          asset,
          amount,
        }),
      )
      .addMemo(memo)
      .setTimeout(60)
      .build();

    return { xdr: tx.toXDR(), network_passphrase: NETWORK_PASSPHRASE };
  }
}
