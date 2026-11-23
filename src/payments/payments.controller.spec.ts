import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuthedRequest } from '../auth/auth.guard';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { SessionsService } from '../sessions/sessions.service';
import { SessionsController } from '../sessions/sessions.controller';

const LINK_ID = '11111111-1111-4111-8111-111111111111';
const PAYER = 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB';

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
      expect(() => controller.prepareTx(LINK_ID, '123', payer)).toThrow(BadRequestException);
      expect(calls).toEqual([]);
    },
  );

  it('passes a well-formed payer through to the service', async () => {
    const payer = 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB';
    await controller.prepareTx(LINK_ID, '123', payer);
    expect(calls).toEqual([[LINK_ID, '123', payer]]);
  });

  it('rejects a non-UUID linkId with 400', () => {
    expect(() => controller.prepareTx('not-a-uuid', '123', PAYER)).toThrow(BadRequestException);
    expect(calls).toEqual([]);
  });

  it.each(['-1', 'abc', '99999999999999999999'])('rejects muxed_id %p with 400', (muxedId) => {
    expect(() => controller.prepareTx(LINK_ID, muxedId, PAYER)).toThrow(BadRequestException);
    expect(calls).toEqual([]);
  });
});

describe('PaymentsController other routes', () => {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return Promise.resolve({ name });
  };
  const service = {
    buildPayUri: record('buildPayUri'),
    listForMerchant: record('listForMerchant'),
    hasPendingSession: record('hasPendingSession'),
  } as unknown as PaymentsService;
  const controller = new PaymentsController(service);
  const req = { merchant: { id: 'merchant-1' } } as unknown as AuthedRequest;

  beforeEach(() => {
    for (const k of Object.keys(calls)) delete calls[k];
  });

  describe('buildPayUri', () => {
    it.each([
      ['', '123'],
      [LINK_ID, ''],
    ])('rejects missing params (%p, %p) with 400', (linkId, muxedId) => {
      expect(() => controller.buildPayUri(linkId, muxedId)).toThrow(BadRequestException);
      expect(calls.buildPayUri).toBeUndefined();
    });

    it('rejects a non-UUID linkId with 400', () => {
      expect(() => controller.buildPayUri('not-a-uuid', '123')).toThrow(BadRequestException);
      expect(calls.buildPayUri).toBeUndefined();
    });

    it('rejects a malformed muxed_id with 400', () => {
      expect(() => controller.buildPayUri(LINK_ID, '-5')).toThrow(BadRequestException);
      expect(calls.buildPayUri).toBeUndefined();
    });

    it('passes valid params through to the service', async () => {
      await controller.buildPayUri(LINK_ID, '123');
      expect(calls.buildPayUri).toEqual([[LINK_ID, '123']]);
    });
  });

  describe('listMine', () => {
    it('passes the session merchant id and defaults through', async () => {
      await controller.listMine(req, {} as never);
      expect(calls.listForMerchant).toEqual([['merchant-1', 25, 0]]);
    });

    it('passes explicit limit/offset through', async () => {
      await controller.listMine(req, { limit: 10, offset: 20 } as never);
      expect(calls.listForMerchant).toEqual([['merchant-1', 10, 20]]);
    });
  });

  describe('pendingMine', () => {
    it('checks pending sessions for the session merchant', async () => {
      await controller.pendingMine(req);
      expect(calls.hasPendingSession).toEqual([['merchant-1']]);
    });
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
