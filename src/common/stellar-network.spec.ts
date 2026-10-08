import { assertNetworkReady, missingForNetwork, resolveStellarNetwork } from './stellar-network';

describe('stellar network config', () => {
  it('defaults to testnet', () => {
    expect(resolveStellarNetwork({})).toBe('testnet');
  });

  it('accepts exactly testnet or mainnet', () => {
    expect(resolveStellarNetwork({ STELLAR_NETWORK: 'mainnet' })).toBe('mainnet');
    expect(() => resolveStellarNetwork({ STELLAR_NETWORK: 'futurenet' })).toThrow(/must be "testnet" or "mainnet"/);
  });

  it('refuses mainnet, naming every identifier that has no testnet default', () => {
    expect(() => assertNetworkReady('mainnet', {})).toThrow(/USDC_ISSUER.*COMPLIANCE_CONTRACT_ID.*DEPLOYER_ADDRESS/s);
  });

  it('allows mainnet once every identifier is set explicitly', () => {
    const env = Object.fromEntries(missingForNetwork('mainnet', {}).map((name) => [name, 'X']));
    expect(missingForNetwork('mainnet', env)).toEqual([]);
    expect(() => assertNetworkReady('mainnet', env)).not.toThrow();
  });

  it('allows testnet with no extra configuration', () => {
    expect(() => assertNetworkReady('testnet', {})).not.toThrow();
  });
});
