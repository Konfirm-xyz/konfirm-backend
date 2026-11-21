import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

const meta = { type: 'body' as const, metatype: Object, data: '' };

describe('ZodValidationPipe', () => {
  it('passes through and coerces a valid value', () => {
    const pipe = new ZodValidationPipe(z.object({ n: z.coerce.number() }));
    const result = pipe.transform({ n: '42' }, meta);
    expect(result).toEqual({ n: 42 });
  });

  it('throws BadRequestException with path:message for a ZodError', () => {
    const pipe = new ZodValidationPipe(z.object({ email: z.string().email() }));
    expect(() => pipe.transform({ email: 'not-an-email' }, meta)).toThrow(BadRequestException);
    try {
      pipe.transform({ email: 'not-an-email' }, meta);
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const msg = (err as BadRequestException).message;
      expect(msg).toContain('email');
    }
  });

  it('throws BadRequestException for a non-Zod error without leaking it', () => {
    const schema = { parse: () => { throw new Error('something internal'); } } as unknown as import('zod').ZodSchema;
    const pipe = new ZodValidationPipe(schema);
    expect(() => pipe.transform({}, meta)).toThrow(BadRequestException);
    try {
      pipe.transform({}, meta);
    } catch (err) {
      expect((err as BadRequestException).message).toBe('invalid request');
    }
  });
});
