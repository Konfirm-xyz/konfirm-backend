import { BadRequestException } from '@nestjs/common';
import { Asset } from '@stellar/stellar-sdk';

// Circle's official testnet USDC issuer on Stellar — the same asset every
// Stellar testnet tutorial, wallet, and the reference anchor at
// testanchor.stellar.org all point at, not a placeholder.
export const USDC_TESTNET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// Circle's official testnet EURC issuer (developers.circle.com/stablecoins/
// eurc-contract-addresses) — confirmed live against Horizon's /assets
// endpoint before use, same standard as the USDC issuer above. Must match
// reconciler/src/main.rs's EURC_TESTNET_ISSUER.
export const EURC_TESTNET_ISSUER = 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO';

export function resolveAsset(currency: string): Asset {
  if (currency === 'XLM') return Asset.native();
  if (currency === 'USDC') return new Asset('USDC', USDC_TESTNET_ISSUER);
  if (currency === 'EURC') return new Asset('EURC', EURC_TESTNET_ISSUER);
  throw new BadRequestException(`${currency} is not supported yet`);
}
