import { resolveTrustProxyHops } from './trust-proxy';

describe('resolveTrustProxyHops', () => {
  it('defaults to one hop in production, the Railway edge', () => {
    expect(resolveTrustProxyHops({ NODE_ENV: 'production' })).toBe(1);
  });

  it('defaults to zero outside production', () => {
    expect(resolveTrustProxyHops({ NODE_ENV: 'development' })).toBe(0);
  });

  it('honours an explicit value', () => {
    expect(resolveTrustProxyHops({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '2' })).toBe(2);
  });

  it('rejects anything that is not a small integer', () => {
    expect(() => resolveTrustProxyHops({ TRUST_PROXY_HOPS: 'yes' })).toThrow(/integer from 0 to 10/);
    expect(() => resolveTrustProxyHops({ TRUST_PROXY_HOPS: '-1' })).toThrow();
    expect(() => resolveTrustProxyHops({ TRUST_PROXY_HOPS: '99' })).toThrow();
  });
});
