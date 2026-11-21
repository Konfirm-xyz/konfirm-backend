import { nonNegativeIntegerStringSchema, nonNegativeDecimalStringSchema, parsePaginationInt, POSTGRES_BIGINT_MAX } from './numeric-validation';

describe('nonNegativeIntegerStringSchema', () => {
  const schema = nonNegativeIntegerStringSchema(POSTGRES_BIGINT_MAX, 'amount');

  it('accepts zero', () => {
    expect(schema.safeParse('0').success).toBe(true);
  });

  it('accepts the maximum value', () => {
    expect(schema.safeParse(POSTGRES_BIGINT_MAX.toString()).success).toBe(true);
  });

  it('rejects a non-numeric string', () => {
    expect(schema.safeParse('not-a-number').success).toBe(false);
  });

  it('rejects a negative number', () => {
    expect(schema.safeParse('-1').success).toBe(false);
  });

  it('rejects a value exceeding the max', () => {
    expect(schema.safeParse((POSTGRES_BIGINT_MAX + 1n).toString()).success).toBe(false);
  });

  it('does not throw on bad input (regex+refine both run)', () => {
    // Both the .regex() and .refine() run even when regex fails; a SyntaxError
    // from BigInt() inside refine must not propagate.
    expect(() => schema.safeParse('not-a-number')).not.toThrow();
  });
});

describe('nonNegativeDecimalStringSchema', () => {
  const schema = nonNegativeDecimalStringSchema('price', 7, 9_223_372_036_854_775_807n);

  it('accepts an integer string', () => {
    expect(schema.safeParse('100').success).toBe(true);
  });

  it('accepts a string with up to scale decimal places', () => {
    expect(schema.safeParse('1.1234567').success).toBe(true);
  });

  it('rejects a string with more than scale decimal places', () => {
    expect(schema.safeParse('1.12345678').success).toBe(false);
  });

  it('rejects a non-numeric string without throwing', () => {
    expect(() => schema.safeParse('abc')).not.toThrow();
    expect(schema.safeParse('abc').success).toBe(false);
  });
});

describe('parsePaginationInt', () => {
  it('returns undefined for undefined input', () => {
    expect(parsePaginationInt(undefined)).toBeUndefined();
  });

  it('returns undefined for a non-numeric string', () => {
    expect(parsePaginationInt('abc')).toBeUndefined();
  });

  it('parses a valid non-negative integer string', () => {
    expect(parsePaginationInt('42')).toBe(42);
  });

  it('returns undefined for a negative number string', () => {
    expect(parsePaginationInt('-1')).toBeUndefined();
  });
});
