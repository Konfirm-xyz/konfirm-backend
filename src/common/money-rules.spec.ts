import * as vectors from '../../money-rules/vectors.json';
import { feeStroops, fromStroops, owedFee, toStroops } from './money-rules';

describe('money rules (shared golden vectors)', () => {
  it.each(vectors.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(owedFee(v.amount, v.bps, v.floor)).toBe(v.fee);
  });

  it('round-trips stroops exactly', () => {
    expect(fromStroops(toStroops('12.3456789'))).toBe('12.3456789');
  });

  it('never charges a fee on a zero amount, even with a floor', () => {
    expect(feeStroops(0n, 100, 500_000n)).toBe(0n);
  });
});
