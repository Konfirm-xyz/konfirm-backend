import { totalsByAsset } from './fees.service';
import { fromStroops, toStroops } from '../common/money-rules';

describe('fee arithmetic', () => {
  it('converts to stroops and back without drift', () => {
    expect(toStroops('0.1000000')).toBe(1_000_000n);
    expect(fromStroops(toStroops('12.3456789'))).toBe('12.3456789');
    expect(fromStroops(toStroops('0.0000001'))).toBe('0.0000001');
    expect(fromStroops(0n)).toBe('0.0000000');
  });

  it('sums many small fees exactly, where floats would drift', () => {
    // 0.1 + 0.2 is not 0.3 in binary floating point. Settlement must be exact.
    const rows = [
      { id: '1', fee_owed_raw: '0.1000000', fee_asset_code: 'XLM', fee_asset_issuer: null },
      { id: '2', fee_owed_raw: '0.2000000', fee_asset_code: 'XLM', fee_asset_issuer: null },
    ];
    expect(totalsByAsset(rows)).toEqual([{ code: 'XLM', issuer: null, amount: '0.3000000', payments: 2 }]);
  });

  it('keeps each asset and issuer separate', () => {
    const rows = [
      { id: '1', fee_owed_raw: '1.0000000', fee_asset_code: 'USDC', fee_asset_issuer: 'GISSUER' },
      { id: '2', fee_owed_raw: '2.0000000', fee_asset_code: 'USDC', fee_asset_issuer: 'GOTHER' },
      { id: '3', fee_owed_raw: '0.5000000', fee_asset_code: 'USDC', fee_asset_issuer: 'GISSUER' },
    ];
    const totals = totalsByAsset(rows);
    expect(totals).toHaveLength(2);
    expect(totals.find((t) => t.issuer === 'GISSUER')).toMatchObject({ amount: '1.5000000', payments: 2 });
    expect(totals.find((t) => t.issuer === 'GOTHER')).toMatchObject({ amount: '2.0000000', payments: 1 });
  });
});
