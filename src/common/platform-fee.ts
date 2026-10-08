import { BadRequestException } from '@nestjs/common';
import { createEd25519Signer } from '@x402/stellar';
import type { Ed25519Signer } from '@x402/stellar';
import { NETWORK_CAIP2 } from './stellar-network';

// A dedicated Stellar account for Konfirm's own checkout fee revenue --
// deliberately separate from the x402 facilitator's own signing address
// (getFacilitatorSigner() in facilitator-signer.ts). Reusing that address
// would let facilitator-sweep.service.ts commingle gas-relay float with
// real merchant fee revenue with no bookkeeping boundary between them.
// This account only ever receives at checkout time -- see
// scripts/setup-fee-collection-account.mjs for how it was created, and
// reconciler/src/main.rs's PLATFORM_FEE_ADDRESS for the Rust side, which
// must match this value.
export function platformFeeAddress(): string {
  const address = process.env.PLATFORM_FEE_ADDRESS;
  if (!address) {
    throw new BadRequestException('platform fee collection is not configured (PLATFORM_FEE_ADDRESS unset)');
  }
  return address;
}

// Raw secret key only, no KMS path -- unlike the facilitator's signer, this
// account only ever signs one operation type (sweeping its own accumulated
// balance into the treasury contract), a far smaller blast radius than a
// key that can sign arbitrary x402/channel submissions. Revisit this if
// that changes. Not memoized like getFacilitatorSigner(): the sweep this
// backs runs at most once per configured interval, not per-request, so
// there's no hot path to optimize here.
export function getFeeCollectionSigner(): Ed25519Signer {
  const secretKey = process.env.PLATFORM_FEE_SECRET_KEY;
  if (!secretKey) {
    throw new BadRequestException('platform fee sweep is not configured (PLATFORM_FEE_SECRET_KEY unset)');
  }
  return createEd25519Signer(secretKey, NETWORK_CAIP2);
}
