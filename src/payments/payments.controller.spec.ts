import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { SessionsService } from '../sessions/sessions.service';
import { SessionsController } from '../sessions/sessions.controller';

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

// The checkout page's /pay/[linkId] route hits these two endpoints with
// whatever is in the URL. A non-UUID linkId used to reach Postgres and throw
// on the uuid cast — a 500 (and Sentry capture) instead of a 404.
describe('malformed linkId handling', () => {
  it('SessionsService.reserve 404s for a non-UUID linkId', async () => {
    await expect(new SessionsService().reserve('not-a-uuid', '123')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('SessionsService.statusFor 404s for a non-UUID linkId', async () => {
    await expect(new SessionsService().statusFor('not-a-uuid', '123')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('SessionsController.status 404s for a non-UUID linkId', async () => {
    const controller = new SessionsController({} as unknown as SessionsService);
    await expect(controller.status('not-a-uuid', '123')).rejects.toBeInstanceOf(NotFoundException);
  });
});
