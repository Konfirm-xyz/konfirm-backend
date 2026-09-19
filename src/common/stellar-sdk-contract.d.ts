// Ambient shim for `@stellar/stellar-sdk/contract`. Same root cause and
// same fix as `src/x402/x402-stellar-facilitator.d.ts`: this project's
// module resolution (module: commonjs, the classic/node10 resolver —
// required elsewhere since @stellar/stellar-sdk itself is ESM-only and a
// node16/nodenext switch breaks that import project-wide) can't follow
// package.json `exports`-map subpaths for type resolution, even though the
// real .d.ts exists and Node's own runtime `require` resolves the subpath
// fine. Transcribed from the real declarations (@stellar/stellar-sdk@16.2.0,
// lib/esm/contract/{client,assembled_transaction,sent_transaction,types}.d.ts).
//
// Originally scoped to only what onchain-compliance.ts's read-only
// `is_allowed` simulation needed (no signing at all). Extended by
// payment-attestation.service.ts — the first *write* call through this
// shim — to add signTransaction/signAuthEntry (real submission needs a
// signer, not just a publicKey for simulation) and signAndSend/
// sendTransactionResponse (submitting and reading back the real tx hash).
// Extend further, don't narrow — other real members exist upstream but
// stay untranscribed until something actually calls them, matching the
// original file's own stated methodology.
declare module '@stellar/stellar-sdk/contract' {
  type SignTransaction = (
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string; submit?: boolean; submitUrl?: string },
  ) => Promise<{ signedTxXdr: string; signerAddress?: string; error?: unknown }>;

  type SignAuthEntry = (
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string },
  ) => Promise<{ signedAuthEntry: string; signerAddress?: string; error?: unknown }>;

  export type MethodOptions = {
    fee?: string;
    timeoutInSeconds?: number;
    simulate?: boolean;
    restore?: boolean;
    publicKey?: string;
  };

  export type ClientOptions = MethodOptions & {
    contractId: string;
    networkPassphrase: string;
    rpcUrl: string;
    allowHttp?: boolean;
    headers?: Record<string, string>;
    // Real type is SignTransactionLike/SignAuthEntryLike (a function, or a
    // Signer/Keypair the SDK converts internally) — narrowed here to just
    // the function form, since that's the only shape getFacilitatorSigner()
    // ever returns.
    signTransaction?: SignTransaction;
    signAuthEntry?: SignAuthEntry;
  };

  // record_payment returns Result<u64, PaymentError> in Rust (a real
  // #[contracterror] Result, not a plain value like is_allowed's bare
  // bool) -- confirmed empirically, not assumed: AssembledTransaction.result
  // for a call like this is a real Ok/Err instance (`Ok { value: 4n }`,
  // observed against a live testnet call), not the bare u64 that
  // `String(result)` would need. .unwrap()/.isOk() is the real, minimal
  // Result API this SDK actually exposes for exactly this case.
  export interface Result<T> {
    unwrap(): T;
    unwrapErr(): { message: string };
    isOk(): boolean;
    isErr(): boolean;
  }

  export class AssembledTransaction<T> {
    readonly result: T;
    signAndSend(opts?: { force?: boolean; signTransaction?: SignTransaction }): Promise<SentTransaction<T>>;
  }

  export class SentTransaction<T> {
    readonly result: T;
    sendTransactionResponse?: { hash: string; status: string };
  }

  export class Client {
    static from<T = unknown>(options: ClientOptions): Promise<Client & T>;
  }
}
