import { BadRequestException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { pool } from '../db/pool';
import * as effectiveFee from '../common/effective-fee';

describe('PaymentsService.buildPayUri', () => {
  const service = new PaymentsService();
  let querySpy: jest.SpyInstance;
  let feeBpsSpy: jest.SpyInstance;

  beforeEach(() => {
    querySpy = jest.spyOn(pool, 'query');
    feeBpsSpy = jest.spyOn(effectiveFee, 'getEffectiveFeeBps');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects SEP-7 pay-uri for a link with a non-zero effective platform fee (#63)', async () => {
    querySpy.mockResolvedValueOnce({
      rows: [
        {
          id: 'link-1',
          amount_usdc: '25.0000000',
          currency: 'XLM',
          active: true,
          expires_at: null,
          merchant_id: 'merchant-1',
          stellar_base_address: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
          merchant_status: 'active',
        },
      ],
    } as never);
    feeBpsSpy.mockResolvedValueOnce(50);

    await expect(service.buildPayUri('link-1', '1001')).rejects.toThrow(BadRequestException);
    expect(feeBpsSpy).toHaveBeenCalledWith('merchant-1');
  });

  it('builds a valid SEP-7 pay-uri when effective fee_bps is 0 (promo/zero-fee merchant)', async () => {
    querySpy.mockResolvedValueOnce({
      rows: [
        {
          id: 'link-2',
          amount_usdc: '25.0000000',
          currency: 'XLM',
          active: true,
          expires_at: null,
          merchant_id: 'merchant-promo',
          stellar_base_address: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
          merchant_status: 'active',
        },
      ],
    } as never);
    feeBpsSpy.mockResolvedValueOnce(0);

    const res = await service.buildPayUri('link-2', '1002');
    expect(res.uri).toContain('web+stellar:pay?');
    expect(res.uri).toContain(
      'destination=GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
    );
    expect(res.uri).toContain('amount=25.0000000');
    expect(res.uri).toContain('memo=1002');
    expect(res.uri).toContain('memo_type=MEMO_ID');
  });
});
