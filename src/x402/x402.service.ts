/// <reference path="./x402-stellar-facilitator.d.ts" />
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { X402_USDC_ADDRESS, RPC_URL } from '../common/stellar-network';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from './x402.types';
import { pool } from '../db/pool';
import { isAllowedOnChain } from '../common/onchain-compliance';
import { getFacilitatorSigner, withFacilitatorSubmissionLock } from '../common/facilitator-signer';
import { NETWORK_CAIP2 } from '../common/stellar-network';

@Injectable()
export class X402Service implements OnModuleInit {
  private readonly logger = new Logger(X402Service.name);
  private scheme!: ExactStellarScheme;

  // Constructed once at startup, not per-request — ExactStellarScheme signs
  // in-process with the facilitator key, so the signer only needs to be
  // resolved once. The signer
  // itself is shared with ChannelService via getFacilitatorSigner() — same
  // identity, same key, one resolution.
  async onModuleInit() {
    const signer = await getFacilitatorSigner();
    this.scheme = new ExactStellarScheme([signer], {
      rpcConfig: { url: RPC_URL },
    });
    this.logger.log(`x402 facilitator ready, signing address ${signer.address}`);
  }

  getSupported(): SupportedResponse {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact',
          network: NETWORK_CAIP2,
          extra: this.scheme.getExtra(NETWORK_CAIP2),
        },
      ],
      extensions: [],
    };
  }

  // Same local-blocklist-then-on-chain-contract pattern as
  // payments.service.ts's isPayerAllowed — now protecting a third payment
  // path (Freighter checkout, the reconciler's after-the-fact SEP-7
  // screening, and this inline x402 verification). The on-chain half is
  // now a shared module (src/common/onchain-compliance.ts) rather than
  // duplicated CLI-shell code — both call sites moved off the `stellar`
  // CLI to a direct Soroban RPC call together.
  private async isPayerAllowed(address: string): Promise<boolean> {
    const { rows } = await pool.query('SELECT 1 FROM blocked_addresses WHERE stellar_address = $1', [address]);
    if (rows.length > 0) return false;
    return isAllowedOnChain(address);
  }

  // Deterministic per-signed-payload key: hashing the base64 transaction
  // blob (rather than hand-parsing the auth entry's nonce out of the XDR)
  // is enough to make a resubmitted identical payload a no-op at the
  // facilitator level — genuine replay protection is Soroban's own
  // auth-entry nonce on-chain; this is the secondary, belt-and-suspenders
  // layer, so it doesn't need to reimplement XDR parsing to do its job.
  private idempotencyKey(payer: string, payload: PaymentPayload): string {
    const raw = JSON.stringify(payload.payload);
    const hash = createHash('sha256').update(raw).digest('hex');
    return `${payer}:${hash}`;
  }

  private async recordAttempt(params: {
    payer: string;
    requirements: PaymentRequirements;
    status: 'settled' | 'failed' | 'held';
    txHash: string | null;
    idempotencyKey: string;
  }) {
    try {
      await pool.query(
        `INSERT INTO x402_settlements (payer_address, pay_to, asset_contract, amount, resource_url, status, tx_hash, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          params.payer,
          params.requirements.payTo,
          params.requirements.asset,
          params.requirements.amount,
          null,
          params.status,
          params.txHash,
          params.idempotencyKey,
        ],
      );
    } catch (err) {
      this.logger.error(`failed to record x402 settlement attempt: ${err}`);
    }
  }

  // v1 scope guard, checked before the package is ever called — one
  // scheme, one network, one asset, per this facilitator's deliberately
  // narrow launch scope.
  private outOfScopeReason(x402Version: number, requirements: PaymentRequirements): string | null {
    if (x402Version !== 2) return 'unsupported_x402_version';
    if (requirements.scheme !== 'exact') return 'unsupported_scheme';
    if (requirements.network !== NETWORK_CAIP2) return 'unsupported_network';
    if (requirements.asset !== X402_USDC_ADDRESS) return 'unsupported_asset';
    return null;
  }

  async verify(x402Version: number, payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const scopeReason = this.outOfScopeReason(x402Version, requirements);
    if (scopeReason) return { isValid: false, invalidReason: scopeReason };

    const protocolResult = await this.scheme.verify(payload, requirements);
    if (!protocolResult.isValid) return protocolResult;

    // The package's own facilitator-safety checks (payer/tx source can't be
    // the facilitator itself, no sub-invocations, etc.) already ran inside
    // scheme.verify() above — this is Konfirm's own additional layer, run
    // only once the protocol-level check has already passed.
    const payer = protocolResult.payer;
    if (payer) {
      const allowed = await this.isPayerAllowed(payer);
      if (!allowed) {
        await this.recordAttempt({
          payer,
          requirements,
          status: 'held',
          txHash: null,
          idempotencyKey: this.idempotencyKey(payer, payload),
        });
        return { ...protocolResult, isValid: false, invalidReason: 'compliance_blocked' };
      }
    }
    return protocolResult;
  }

  // Never settles something unverified — verify() (protocol check +
  // compliance check together) runs first, and scheme.settle() is only
  // called if both pass.
  async settle(x402Version: number, payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const verifyResult = await this.verify(x402Version, payload, requirements);
    if (!verifyResult.isValid) {
      return {
        success: false,
        errorReason: verifyResult.invalidReason,
        payer: verifyResult.payer,
        transaction: '',
        network: requirements.network,
      };
    }

    try {
      // Serialized against every other facilitator-signed submission
      // (channel open/close, checkpoint, finalize_close) — the package's
      // own settle() fetches the facilitator account's sequence number
      // with no lock of its own, so two settlements (or a settlement and
      // a keeper sweep) landing at the same time will otherwise race on
      // it and one submission fails outright. See facilitator-signer.ts.
      const result = await withFacilitatorSubmissionLock(() => this.scheme.settle(payload, requirements));
      const payer = result.payer ?? verifyResult.payer;
      if (payer) {
        await this.recordAttempt({
          payer,
          requirements,
          status: result.success ? 'settled' : 'failed',
          txHash: result.success ? result.transaction : null,
          idempotencyKey: this.idempotencyKey(payer, payload),
        });
      }
      return result;
    } catch (err) {
      this.logger.error(`x402 settlement failed: ${err}`);
      const payer = verifyResult.payer;
      if (payer) {
        await this.recordAttempt({
          payer,
          requirements,
          status: 'failed',
          txHash: null,
          idempotencyKey: this.idempotencyKey(payer, payload),
        });
      }
      return {
        success: false,
        errorReason: 'settlement_error',
        payer,
        transaction: '',
        network: requirements.network,
      };
    }
  }
}
