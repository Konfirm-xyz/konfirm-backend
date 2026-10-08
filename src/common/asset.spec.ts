import { BadRequestException } from '@nestjs/common';
import { resolveAsset } from './asset';
import { EURC_ISSUER, USDC_ISSUER } from './stellar-network';

describe('resolveAsset', () => {
  it('resolves XLM to the native asset', () => {
    const asset = resolveAsset('XLM');
    expect(asset.isNative()).toBe(true);
  });

  it('resolves USDC to the real testnet issuer, not a placeholder', () => {
    const asset = resolveAsset('USDC');
    expect(asset.isNative()).toBe(false);
    expect(asset.getCode()).toBe('USDC');
    expect(asset.getIssuer()).toBe(USDC_ISSUER);
  });

  it('resolves EURC to the real testnet issuer, not a placeholder', () => {
    const asset = resolveAsset('EURC');
    expect(asset.isNative()).toBe(false);
    expect(asset.getCode()).toBe('EURC');
    expect(asset.getIssuer()).toBe(EURC_ISSUER);
  });

  it('rejects garbage input rather than defaulting to something plausible-looking', () => {
    expect(() => resolveAsset('not-a-currency')).toThrow(BadRequestException);
  });
});
