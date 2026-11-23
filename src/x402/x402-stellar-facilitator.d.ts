// Ambient shim for `@x402/stellar/exact/facilitator`'s ExactStellarScheme.
// The package's real declaration file imports its parameter/return types
// from `@x402/core/types`, which this project's module resolution can't
// follow (see x402.types.ts for why) — so instead of importing the real
// .d.ts, this transcribes the constructor and method signatures verbatim
// from it (dist/cjs/exact/facilitator/index.d.ts, @x402/stellar@2.22.0),
// typed against this project's own local mirror of those shapes.
declare module '@x402/stellar/exact/facilitator' {
  import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from './x402.types';

  interface RpcConfig {
    url?: string;
  }

  interface FacilitatorStellarSigner {
    address: string;
    // Method-shorthand (not a property typed as an arrow function) so
    // structural assignment from the real @x402/stellar Ed25519Signer
    // (whose signAuthEntry/signTransaction have concrete, non-`unknown`
    // parameter types) is checked bivariantly rather than tripping
    // strictFunctionTypes' contravariance rule.
    signAuthEntry(...args: unknown[]): unknown;
    signTransaction(...args: unknown[]): unknown;
  }

  export class ExactStellarScheme {
    readonly scheme: 'exact';
    readonly caipFamily: 'stellar:*';
    readonly signingAddresses: ReadonlySet<string>;
    readonly areFeesSponsored: boolean;
    readonly rpcConfig?: RpcConfig;
    readonly maxTransactionFeeStroops: number;
    readonly inclusionFeeStroops: number;
    readonly feeBumpSigner?: FacilitatorStellarSigner;

    constructor(
      signers: FacilitatorStellarSigner[],
      options?: {
        rpcConfig?: RpcConfig;
        areFeesSponsored?: boolean;
        maxTransactionFeeStroops?: number;
        // Inclusion fee bid (stroops) on top of the resource fee, default 100.
        // Mainnet often needs more for Soroban txs to be included.
        inclusionFeeStroops?: number;
        selectSigner?: (addresses: readonly string[]) => string;
        feeBumpSigner?: FacilitatorStellarSigner;
      },
    );

    getExtra(network: string): Record<string, unknown> | undefined;
    getSigners(network: string): string[];
    verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
    settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  }
}
