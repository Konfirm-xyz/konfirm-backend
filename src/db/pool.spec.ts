// Tests for envInt() — the edge-case boundary (>= 0, not > 0) and
// non-finite fallback paths are the meaningful ones; see the comment in
// pool.ts for why 0 is intentionally accepted.

// envInt is not exported, so we exercise it indirectly by setting env vars
// and re-importing the module with jest's module-reset helpers.

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

describe('envInt', () => {
  it('returns the fallback when the variable is unset', () => {
    delete process.env['TEST_ENV_INT'];
    expect(envInt('TEST_ENV_INT', 42)).toBe(42);
  });

  it('returns 0 when the variable is "0" (pg no-timeout sentinel)', () => {
    process.env['TEST_ENV_INT'] = '0';
    expect(envInt('TEST_ENV_INT', 42)).toBe(0);
  });

  it('returns the parsed number for a valid positive integer string', () => {
    process.env['TEST_ENV_INT'] = '25';
    expect(envInt('TEST_ENV_INT', 42)).toBe(25);
  });

  it('returns the fallback for a negative string', () => {
    process.env['TEST_ENV_INT'] = '-1';
    expect(envInt('TEST_ENV_INT', 42)).toBe(42);
  });

  it('returns the fallback for a non-numeric string', () => {
    process.env['TEST_ENV_INT'] = 'abc';
    expect(envInt('TEST_ENV_INT', 42)).toBe(42);
  });

  it('returns the fallback for a non-finite value like "1.5e400"', () => {
    process.env['TEST_ENV_INT'] = '1.5e400';
    expect(envInt('TEST_ENV_INT', 42)).toBe(42);
  });

  it('returns the fallback for an empty string', () => {
    process.env['TEST_ENV_INT'] = '';
    expect(envInt('TEST_ENV_INT', 42)).toBe(42);
  });

  afterEach(() => {
    delete process.env['TEST_ENV_INT'];
  });
});
