import { Keypair } from '@stellar/stellar-sdk';
import { assertSeparateHotKeys } from './facilitator-signer';

describe('assertSeparateHotKeys', () => {
  const a = Keypair.random().secret();
  const b = Keypair.random().secret();
  const c = Keypair.random().secret();

  it('passes when every configured key is a different account', () => {
    expect(() =>
      assertSeparateHotKeys({ STELLAR_DEPLOYER_SECRET_KEY: a, FACILITATOR_SECRET_KEY: b, PLATFORM_FEE_SECRET_KEY: c }),
    ).not.toThrow();
  });

  it('refuses the facilitator reusing the deployer key', () => {
    expect(() => assertSeparateHotKeys({ STELLAR_DEPLOYER_SECRET_KEY: a, FACILITATOR_SECRET_KEY: a })).toThrow(
      /same account/,
    );
  });

  it('refuses the fee account reusing the facilitator key', () => {
    expect(() => assertSeparateHotKeys({ FACILITATOR_SECRET_KEY: b, PLATFORM_FEE_SECRET_KEY: b })).toThrow(/same account/);
  });

  it('rejects something that is not a Stellar secret', () => {
    expect(() => assertSeparateHotKeys({ FACILITATOR_SECRET_KEY: 'not-a-key' })).toThrow(/not a valid Stellar secret/);
  });
});
