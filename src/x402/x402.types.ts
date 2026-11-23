// Local mirror of the relevant `@x402/core/types` shapes (VerifyRequest/
// VerifyResponse/SettleRequest/SettleResponse/PaymentPayload/
// PaymentRequirements), transcribed verbatim from the package's own type
// declarations. Not re-exported from the real module: this project's
// tsconfig (module: commonjs, the classic/node10 resolver — required
// elsewhere since @stellar/stellar-sdk is itself ESM-only and a
// node16/nodenext switch breaks that import project-wide) can't resolve
// @x402/core's `exports`-map subpath types. Duplicating the shape here is
// far lower-risk than a global module-resolution change for one new
// module.
export type Network = `${string}:${string}`;

export interface PaymentRequirements {
  scheme: string;
  network: Network;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: { url: string; [key: string]: unknown };
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
  extensions?: Record<string, unknown>;
  extensionResponses?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: Network;
  amount?: string;
  extensions?: Record<string, unknown>;
  extensionResponses?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

// GET /x402/supported — advertises what this facilitator handles. Not
// optional: the official @x402/core resource-server package
// (HTTPFacilitatorClient.getSupported()) calls this at its own startup and
// refuses to boot ("no supported payment kinds loaded from any facilitator")
// if it's missing — confirmed via skills.stellar.org's agentic-payments
// skill, which documents this exact failure mode for OZ Channels' API-key
// requirement and applies identically to any facilitator implementation.
export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: Network;
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions: string[];
}
