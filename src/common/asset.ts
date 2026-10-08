import { BadRequestException } from '@nestjs/common';
import { Asset } from '@stellar/stellar-sdk';
import { EURC_ISSUER, USDC_ISSUER } from './stellar-network';

export function resolveAsset(currency: string): Asset {
  if (currency === 'XLM') return Asset.native();
  if (currency === 'USDC') return new Asset('USDC', USDC_ISSUER);
  if (currency === 'EURC') return new Asset('EURC', EURC_ISSUER);
  throw new BadRequestException(`${currency} is not supported yet`);
}
