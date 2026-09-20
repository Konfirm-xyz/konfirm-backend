import { BadRequestException } from '@nestjs/common';

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
