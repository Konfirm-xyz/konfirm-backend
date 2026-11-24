import * as vectors from '../../money-rules/vectors.json';
import { feeStroops, fromStroops, owedFee, platformFeeFloor, toStroops } from './money-rules';

describe('money rules (shared golden vectors)', () => {
  it.each(vectors.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(owedFee(v.amount, v.bps, v.floor)).toBe(v.fee);
  });

  it.each(vectors.rejected_inputs.map((v) => [v.name, v] as const))('rejects %s', (_name, v) => {
    expect(() => owedFee(v.amount, v.bps, v.floor)).toThrow(RangeError);
  });

  it('round-trips stroops exactly', () => {
    expect(fromStroops(toStroops('12.3456789'))).toBe('12.3456789');
  });

  it('never charges a fee on a zero amount, even with a floor', () => {
    expect(feeStroops(0n, 100, 500_000n)).toBe(0n);
  });
});

describe('toStroops / fromStroops sign handling', () => {
  it('throws on a negative decimal instead of returning the wrong magnitude', () => {
    expect(() => toStroops('-5.5')).toThrow(RangeError);
    expect(() => toStroops('-0.0000001')).toThrow(RangeError);
  });

  it('throws on a negative stroop amount instead of producing a malformed string', () => {
    expect(() => fromStroops(-45_000_000n)).toThrow(RangeError);
    expect(() => fromStroops(-1n)).toThrow(RangeError);
  });

  it.each(['', '.', '1e5', '0x10', '5.-5', 'abc'])('rejects the malformed amount %p', (input) => {
    expect(() => toStroops(input)).toThrow(RangeError);
  });

  it('still accepts the forms that worked before', () => {
    expect(toStroops('.05')).toBe(500_000n);
    expect(toStroops('5.')).toBe(50_000_000n);
    expect(toStroops(' 0.05 ')).toBe(500_000n);
    expect(toStroops('0.00000019')).toBe(1n);
  });

  it('formats the zero and one-stroop boundaries', () => {
    expect(fromStroops(0n)).toBe('0.0000000');
    expect(fromStroops(1n)).toBe('0.0000001');
  });
});

describe('platformFeeFloor', () => {
  it('returns "0" when PLATFORM_FEE_FLOOR is unset', () => {
    expect(platformFeeFloor({})).toBe('0');
  });

  it('returns the configured value as-is (string passthrough, no parsing)', () => {
    expect(platformFeeFloor({ PLATFORM_FEE_FLOOR: '0.05' })).toBe('0.05');
    expect(platformFeeFloor({ PLATFORM_FEE_FLOOR: '1' })).toBe('1');
  });

  it('returns "0" when PLATFORM_FEE_FLOOR is an empty string', () => {
    expect(platformFeeFloor({ PLATFORM_FEE_FLOOR: '' })).toBe('0');
  });
});
