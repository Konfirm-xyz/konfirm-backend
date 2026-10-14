import { BadRequestException } from '@nestjs/common';
import { ZodValidationPipe } from '../zod-validation.pipe';
import {
  daysQuerySchema,
  limitOnlyQuerySchema,
  paginationQuerySchema,
  statusPaginationQuerySchema,
} from './admin.controller';

describe('AdminController query validation schemas', () => {
  const paginationPipe = new ZodValidationPipe(paginationQuerySchema);
  const statusPaginationPipe = new ZodValidationPipe(statusPaginationQuerySchema);
  const limitOnlyPipe = new ZodValidationPipe(limitOnlyQuerySchema);
  const daysPipe = new ZodValidationPipe(daysQuerySchema);

  describe('paginationQuerySchema ({ limit, offset })', () => {
    it('accepts omitted limit and offset (leaves both undefined so service defaults apply)', () => {
      expect(paginationPipe.transform({})).toEqual({ limit: undefined, offset: undefined });
    });

    it('coerces valid numeric strings to integers', () => {
      expect(paginationPipe.transform({ limit: '25', offset: '0' })).toEqual({ limit: 25, offset: 0 });
      expect(paginationPipe.transform({ limit: '500', offset: '100' })).toEqual({ limit: 500, offset: 100 });
    });

    it.each(['abc', '-1', '-5', '0', '1.5', '501', '10000000', '', '   '])(
      'rejects invalid limit=%p with BadRequestException (400)',
      (limit) => {
        expect(() => paginationPipe.transform({ limit })).toThrow(BadRequestException);
      },
    );

    it.each(['abc', '-1', '-10', '2.5', '100001', '', '   '])(
      'rejects invalid offset=%p with BadRequestException (400)',
      (offset) => {
        expect(() => paginationPipe.transform({ offset })).toThrow(BadRequestException);
      },
    );
  });

  describe('statusPaginationQuerySchema ({ status, limit, offset })', () => {
    it('preserves optional status filter alongside validated limit/offset', () => {
      expect(statusPaginationPipe.transform({ status: 'held', limit: '10', offset: '5' })).toEqual({
        status: 'held',
        limit: 10,
        offset: 5,
      });
    });

    it('rejects non-numeric or negative limit on status-filtered routes', () => {
      expect(() => statusPaginationPipe.transform({ status: 'held', limit: 'abc' })).toThrow(BadRequestException);
      expect(() => statusPaginationPipe.transform({ status: 'held', limit: '-1' })).toThrow(BadRequestException);
    });
  });

  describe('limitOnlyQuerySchema ({ limit })', () => {
    it('accepts omitted or valid integer limit and rejects malformed/negative/excessive values', () => {
      expect(limitOnlyPipe.transform({})).toEqual({ limit: undefined });
      expect(limitOnlyPipe.transform({ limit: '20' })).toEqual({ limit: 20 });
      expect(() => limitOnlyPipe.transform({ limit: 'abc' })).toThrow(BadRequestException);
      expect(() => limitOnlyPipe.transform({ limit: '-1' })).toThrow(BadRequestException);
      expect(() => limitOnlyPipe.transform({ limit: '0' })).toThrow(BadRequestException);
      expect(() => limitOnlyPipe.transform({ limit: '10000000' })).toThrow(BadRequestException);
    });
  });

  describe('daysQuerySchema ({ days })', () => {
    it('accepts omitted or valid days in [1, 365] and rejects malformed/non-positive/excessive values', () => {
      expect(daysPipe.transform({})).toEqual({ days: undefined });
      expect(daysPipe.transform({ days: '30' })).toEqual({ days: 30 });
      expect(() => daysPipe.transform({ days: 'abc' })).toThrow(BadRequestException);
      expect(() => daysPipe.transform({ days: '-1' })).toThrow(BadRequestException);
      expect(() => daysPipe.transform({ days: '0' })).toThrow(BadRequestException);
      expect(() => daysPipe.transform({ days: '366' })).toThrow(BadRequestException);
      expect(() => daysPipe.transform({ days: '' })).toThrow(BadRequestException);
    });
  });
});
