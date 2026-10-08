import { BadRequestException, Injectable } from '@nestjs/common';
import { BASE_FEE, Horizon, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { resolveAsset } from '../common/asset';
import { withRetry } from '../common/retry';
import { AnchorClient } from '../common/anchor-client';
import { ANCHOR_AUTH_URL, ANCHOR_TRANSFER_SERVER, HORIZON_URL, NETWORK_PASSPHRASE } from '../common/stellar-network';

// Same reference anchor as withdrawals.service.ts (see AnchorClient for the
// shared SEP-10/SEP-24 mechanics). Deposits are the mirror direction: get
// test USDC into a wallet, for exercising checkout without an external
// faucet. Not gated behind AuthGuard — there's no Konfirm account involved
// on either side, just an address willing to receive test money.
//
// The SEP-10 login is signed by Freighter, not by scanning a QR with the
// destination wallet — a QR-based `tx`+callback signing request (the SEP-7
// equivalent for a wallet with no browser extension) turned out not to be
// reliably supported: Lobstr rejected a SEP-10 challenge presented that way
// as "invalid or unsupported data." Freighter signing anchor challenges is
// already proven throughout this project (cashout.html), so the funds land
// in whatever account Freighter is connected to first, then get forwarded
// on-chain to the actual destination wallet with one ordinary payment.
@Injectable()
export class DepositsService {
  private horizon = new Horizon.Server(HORIZON_URL);
  private anchor = new AnchorClient(
    { webAuthUrl: ANCHOR_AUTH_URL, transferServerUrl: ANCHOR_TRANSFER_SERVER },
    { partnerLabel: 'test-funds partner', actionNoun: 'deposit' },
  );

  getChallenge(account: string) {
    return this.anchor.getChallenge(account);
  }

  exchangeToken(signedTransaction: string) {
    return this.anchor.exchangeToken(signedTransaction);
  }

  startDeposit(token: string, currency: string, account: string) {
    return this.anchor.startInteractive('deposit', token, currency, account);
  }

  getStatus(token: string, id: string) {
    return this.anchor.getStatus(token, id);
  }

  // The second on-chain leg: once the anchor has deposited test funds into
  // Freighter's own account, forward them to wherever they're actually
  // needed (e.g. a mobile wallet being used for a separate checkout test).
  // Same trustline-bundling logic as payments.service.ts's prepareTx, since
  // the destination may never have held this asset either.
  async prepareTransferPayment(from: string, to: string, currency: string, amount: string) {
    const asset = resolveAsset(currency);
    // Retried: this is Freighter's own account, expected to exist — a
    // failure here is far more likely a network blip than a real 404.
    const fromAccount = await withRetry(() => this.horizon.loadAccount(from), { retries: 2, timeoutMs: 8_000 });

    const builder = new TransactionBuilder(fromAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    });

    if (!asset.isNative()) {
      // Not retried, deliberately: this is a user-typed destination address
      // that may simply not exist — retrying a genuine "not found" three
      // times before reporting it would just make a real mistake feel like
      // a hang.
      let toBalances: Array<{ asset_code?: string; asset_issuer?: string }>;
      try {
        const toAccount = await this.horizon.loadAccount(to);
        toBalances = toAccount.balances as Array<{ asset_code?: string; asset_issuer?: string }>;
      } catch {
        throw new BadRequestException('the destination account was not found on the network');
      }
      const hasTrustline = toBalances.some(
        (b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
      );
      if (!hasTrustline) {
        throw new BadRequestException('the destination wallet has no trustline for this asset yet');
      }
    }

    const tx = builder
      .addOperation(Operation.payment({ destination: to, asset, amount }))
      .setTimeout(60)
      .build();

    return { xdr: tx.toXDR(), network_passphrase: NETWORK_PASSPHRASE };
  }
}
