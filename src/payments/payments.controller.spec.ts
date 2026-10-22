import { BadRequestException } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

describe('PaymentsController.prepareTx', () => {
  const calls: unknown[][] = [];
  const service = {
    prepareTx: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({});
    },
  } as unknown as PaymentsService;
  const controller = new PaymentsController(service);

  beforeEach(() => {
    calls.length = 0;
  });

  it.each(['not-a-valid-address', 'G123', 'gbxbabmfzijptofi6stuxa2fmexdbb4urbd3vs5xdhkmfhgljz5wpqbb'])(
    'rejects payer %p with 400 before reaching Horizon',
    (payer) => {
      expect(() => controller.prepareTx('link-1', '123', payer)).toThrow(BadRequestException);
      expect(calls).toEqual([]);
    },
  );

  it('passes a well-formed payer through to the service', async () => {
    const payer = 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB';
    await controller.prepareTx('link-1', '123', payer);
    expect(calls).toEqual([['link-1', '123', payer]]);
  });
});
