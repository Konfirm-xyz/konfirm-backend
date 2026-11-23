import { assertNetworkReady, missingForNetwork, resolveStellarNetwork } from './stellar-network';

const ACCOUNT = 'GAEMG5TVLEIQYCY3XB4EJT742DIE3FQO53RSESSYJQUZIWZOJQIZATJS';
const CONTRACT = 'CCDMRUZ2JSP7LKGKE7MGOTLKM26IMX6OYJBD7XQHZPKFZMXKOZ32OZ7A';
const VALID: Record<string, string> = {
  USDC_ISSUER: ACCOUNT,
  EURC_ISSUER: ACCOUNT,
  USDC_SAC_ID: CONTRACT,
  X402_USDC_ADDRESS: CONTRACT,
  COMPLIANCE_CONTRACT_ID: CONTRACT,
  PAYMENT_CONTRACT_ID: CONTRACT,
  TREASURY_CONTRACT_ID: CONTRACT,
  CHANNEL_CONTRACT_ID: CONTRACT,
  DEPLOYER_ADDRESS: ACCOUNT,
  FACILITATOR_ADDRESS: ACCOUNT,
  TREASURY_SIGNERS: ACCOUNT,
};

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
    const env = Object.fromEntries(missingForNetwork('mainnet', {}).map((name) => [name, VALID[name] ?? 'X']));
    expect(missingForNetwork('mainnet', env)).toEqual([]);
    expect(() => assertNetworkReady('mainnet', env)).not.toThrow();
  });

  it('rejects a contract ID that is a G... account strkey, naming the variable', () => {
    expect(() => assertNetworkReady('testnet', { USDC_SAC_ID: ACCOUNT })).toThrow(/USDC_SAC_ID/);
  });

  it('rejects a garbage contract ID, naming the variable', () => {
    expect(() => assertNetworkReady('testnet', { PAYMENT_CONTRACT_ID: 'not-a-strkey' })).toThrow(/PAYMENT_CONTRACT_ID/);
  });

  it('rejects an account variable set to a C... contract strkey', () => {
    expect(() => assertNetworkReady('testnet', { USDC_ISSUER: CONTRACT })).toThrow(/USDC_ISSUER/);
  });

  it('rejects malformed testnet overrides for every checked identifier', () => {
    for (const name of [
      'USDC_ISSUER',
      'EURC_ISSUER',
      'USDC_SAC_ID',
      'X402_USDC_ADDRESS',
      'COMPLIANCE_CONTRACT_ID',
      'PAYMENT_CONTRACT_ID',
      'TREASURY_CONTRACT_ID',
      'CHANNEL_CONTRACT_ID',
    ]) {
      expect(() => assertNetworkReady('testnet', { [name]: 'garbage' })).toThrow(new RegExp(name));
    }
  });

  it('allows testnet with no extra configuration', () => {
    expect(() => assertNetworkReady('testnet', {})).not.toThrow();
  });
});
