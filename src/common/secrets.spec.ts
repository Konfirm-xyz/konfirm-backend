import { assertDistinctSecrets, MIN_PRODUCTION_SECRET_LENGTH, resolveSessionSecret } from './secrets';

const DEV = 'dev-only-insecure-secret-change-me';
const STRONG = 'a'.repeat(MIN_PRODUCTION_SECRET_LENGTH);
const silent = () => undefined;

describe('resolveSessionSecret', () => {
  it('uses the env value when set, outside production', () => {
    expect(resolveSessionSecret('JWT_SECRET', DEV, { NODE_ENV: 'development', JWT_SECRET: 'local' }, silent)).toBe('local');
  });

  it('falls back to the dev default outside production, and warns', () => {
    const warn = jest.fn();
    expect(resolveSessionSecret('JWT_SECRET', DEV, { NODE_ENV: 'development' }, warn)).toBe(DEV);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('JWT_SECRET not set'));
  });

  it('refuses to start in production with no secret at all', () => {
    expect(() => resolveSessionSecret('JWT_SECRET', DEV, { NODE_ENV: 'production' }, silent)).toThrow(/must be set in production/);
  });

  it('refuses a short secret in production', () => {
    expect(() =>
      resolveSessionSecret('JWT_SECRET', DEV, { NODE_ENV: 'production', JWT_SECRET: 'short' }, silent),
    ).toThrow(/at least 32 characters/);
  });

  it('refuses the published dev default in production, even when long enough', () => {
    const padded = DEV.padEnd(MIN_PRODUCTION_SECRET_LENGTH, 'x');
    expect(() => resolveSessionSecret('JWT_SECRET', padded, { NODE_ENV: 'production', JWT_SECRET: padded }, silent)).toThrow(
      /published dev default/,
    );
  });

  it('accepts a strong secret in production', () => {
    expect(resolveSessionSecret('JWT_SECRET', DEV, { NODE_ENV: 'production', JWT_SECRET: STRONG }, silent)).toBe(STRONG);
  });
});

describe('assertDistinctSecrets', () => {
  const names: [string, string] = ['JWT_SECRET', 'ADMIN_JWT_SECRET'];

  it('throws in production when the merchant and admin keys match', () => {
    expect(() => assertDistinctSecrets(STRONG, STRONG, names, { NODE_ENV: 'production' })).toThrow(/must be different/);
  });

  it('allows matching values outside production', () => {
    expect(() => assertDistinctSecrets(DEV, DEV, names, { NODE_ENV: 'development' })).not.toThrow();
  });

  it('allows distinct values in production', () => {
    expect(() => assertDistinctSecrets(STRONG, 'b'.repeat(40), names, { NODE_ENV: 'production' })).not.toThrow();
  });
});
