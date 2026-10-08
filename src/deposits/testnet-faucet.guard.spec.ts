import { NotFoundException } from '@nestjs/common';
import { TestnetFaucetGuard } from './testnet-faucet.guard';

describe('TestnetFaucetGuard', () => {
  const guard = new TestnetFaucetGuard();
  const original = process.env.ENABLE_TESTNET_FAUCET;

  afterEach(() => {
    if (original === undefined) delete process.env.ENABLE_TESTNET_FAUCET;
    else process.env.ENABLE_TESTNET_FAUCET = original;
  });

  it('is closed by default', () => {
    delete process.env.ENABLE_TESTNET_FAUCET;
    expect(() => guard.canActivate({} as never)).toThrow(NotFoundException);
  });

  it('is closed for any value other than the exact string "true"', () => {
    process.env.ENABLE_TESTNET_FAUCET = '1';
    expect(() => guard.canActivate({} as never)).toThrow(NotFoundException);
  });

  it('opens only when explicitly enabled', () => {
    process.env.ENABLE_TESTNET_FAUCET = 'true';
    expect(guard.canActivate({} as never)).toBe(true);
  });
});
