import { daysQuerySchema } from '../admin.schemas';
import { ZodValidationPipe } from '../../zod-validation.pipe';
import { BadRequestException } from '@nestjs/common';

describe('Admin Fee Revenue Days Validation (Issue #236)', () => {
  const pipe = new ZodValidationPipe(daysQuerySchema);

  it('accepts undefined/empty query and returns undefined days (defaults at service layer)', () => {
    const result = pipe.transform({});
    expect(result).toEqual({ days: undefined });
  });

  it('accepts valid integer string and transforms to number', () => {
    const result = pipe.transform({ days: '30' });
    expect(result).toEqual({ days: 30 });
  });

  it('accepts valid number directly', () => {
    const result = pipe.transform({ days: 7 });
    expect(result).toEqual({ days: 7 });
  });

  it('accepts boundary values (1 and 3650)', () => {
    expect(pipe.transform({ days: '1' })).toEqual({ days: 1 });
    expect(pipe.transform({ days: '3650' })).toEqual({ days: 3650 });
  });

  it('rejects non-numeric string (e.g. days=abc) with BadRequestException', () => {
    expect(() => pipe.transform({ days: 'abc' })).toThrow(BadRequestException);
  });

  it('rejects zero and negative values with BadRequestException', () => {
    expect(() => pipe.transform({ days: '0' })).toThrow(BadRequestException);
    expect(() => pipe.transform({ days: '-10' })).toThrow(BadRequestException);
  });

  it('rejects numbers exceeding 3650 with BadRequestException', () => {
    expect(() => pipe.transform({ days: '3651' })).toThrow(BadRequestException);
  });

  it('rejects fractional/float numbers with BadRequestException', () => {
    expect(() => pipe.transform({ days: '2.5' })).toThrow(BadRequestException);
  });
});
