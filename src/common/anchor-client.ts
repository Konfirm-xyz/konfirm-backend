import { BadRequestException } from '@nestjs/common';
import { fetchWithRetry } from './retry';

// SEP-10 (auth) and SEP-24 (interactive deposit/withdraw) against one anchor.
// withdrawals.service.ts and deposits.service.ts used to each hand-roll an
// identical copy of this — same endpoints, same retry rules, differing only
// in the two words of copy an error message used. One anchor integration,
// used both directions, same principle as money-rules.ts and
// stellar-network.ts: the thing that has to stay correct lives in one place.
//
// The retry rule is asymmetric on purpose, not uniform:
//   - getChallenge: a GET with no side effect, safe to retry freely.
//   - exchangeToken: a POST, but re-submitting the same already-signed
//     challenge is safe — the anchor either reissues the token or rejects a
//     used one — so one retry only.
//   - startInteractive: no retry. It creates a new transaction on the
//     anchor's side every success, so retrying a lost response risks an
//     orphaned duplicate. A timeout fails fast; it doesn't self-heal.
//   - getStatus: a read, polled repeatedly anyway by the caller.

const FETCH_TIMEOUT_MS = 10_000;

export interface AnchorEndpoints {
  webAuthUrl: string;
  transferServerUrl: string;
}

export interface AnchorCopy {
  /** Used in "could not reach the X" / "the X rejected that signature". */
  partnerLabel: string;
  /** Used in "could not start a X" / "could not check X status". */
  actionNoun: string;
}

// SEP-24's interactive-session response: an id to poll and a hosted URL to
// send the payer to. withdrawals.controller.ts reads `id` to record the
// admin-visibility tracking row; deposits.controller.ts passes the whole
// thing straight through to the caller.
export interface AnchorInteractiveSession {
  id: string;
  url?: string;
  type?: string;
}

export class AnchorClient {
  constructor(
    private readonly endpoints: AnchorEndpoints,
    private readonly copy: AnchorCopy,
  ) {}

  async getChallenge(account: string): Promise<unknown> {
    const res = await fetchWithRetry(
      `${this.endpoints.webAuthUrl}?account=${encodeURIComponent(account)}`,
      {},
      { timeoutMs: FETCH_TIMEOUT_MS },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadRequestException(body.error || `could not reach the ${this.copy.partnerLabel}`);
    return body;
  }

  async exchangeToken(signedTransaction: string): Promise<unknown> {
    const res = await fetchWithRetry(
      this.endpoints.webAuthUrl,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transaction: signedTransaction }) },
      { retries: 1, timeoutMs: FETCH_TIMEOUT_MS },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadRequestException(body.error || `the ${this.copy.partnerLabel} rejected that signature`);
    return body;
  }

  async startInteractive(
    direction: 'deposit' | 'withdraw',
    token: string,
    currency: string,
    account: string,
  ): Promise<AnchorInteractiveSession> {
    const assetCode = currency === 'XLM' ? 'native' : currency;
    const res = await fetch(`${this.endpoints.transferServerUrl}/transactions/${direction}/interactive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_code: assetCode, account }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadRequestException(body.error || `could not start a ${this.copy.actionNoun}`);
    return body;
  }

  async getStatus(token: string, id: string): Promise<unknown> {
    const res = await fetchWithRetry(
      `${this.endpoints.transferServerUrl}/transaction?id=${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${token}` } },
      { timeoutMs: FETCH_TIMEOUT_MS },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadRequestException(body.error || `could not check ${this.copy.actionNoun} status`);
    return (body as { transaction?: unknown }).transaction;
  }
}
