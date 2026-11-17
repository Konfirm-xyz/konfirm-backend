import { BadRequestException } from '@nestjs/common';
import { ZodValidationPipe } from '../../zod-validation.pipe';
import { z } from 'zod';

const setFacilitatorCapSchema = z.object({
  capUsdc: z.number().nonnegative('capUsdc must be non-negative'),
});

describe('Admin Facilitator Cap Validation (Issue #228)', () => {
  const pipe = new ZodValidationPipe(setFacilitatorCapSchema);

  it('accepts valid positive capUsdc', () => {
    const valid = { capUsdc: 500 };
    expect(pipe.transform(valid)).toEqual({ capUsdc: 500 });
  });

  it('accepts zero as a valid capUsdc (disabling spend)', () => {
    const valid = { capUsdc: 0 };
    expect(pipe.transform(valid)).toEqual({ capUsdc: 0 });
  });

  it('accepts floating point cap values', () => {
    const valid = { capUsdc: 250.75 };
    expect(pipe.transform(valid)).toEqual({ capUsdc: 250.75 });
  });

  it('rejects negative numbers with BadRequestException', () => {
    expect(() => pipe.transform({ capUsdc: -1 })).toThrow(BadRequestException);
    expect(() => pipe.transform({ capUsdc: -100 })).toThrow(BadRequestException);
  });

  it('rejects non-numeric string values', () => {
    expect(() => pipe.transform({ capUsdc: '500' })).toThrow(BadRequestException);
    expect(() => pipe.transform({ capUsdc: 'invalid' })).toThrow(BadRequestException);
  });

  it('rejects missing capUsdc field', () => {
    expect(() => pipe.transform({})).toThrow(BadRequestException);
  });
});
