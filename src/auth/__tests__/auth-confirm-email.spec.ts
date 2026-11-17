import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../zod-validation.pipe';

const confirmEmailSchema = z.object({
  token: z.string().min(20).max(200),
});

describe('Confirm Email Schema and Controller Route (Issue #227)', () => {
  const pipe = new ZodValidationPipe(confirmEmailSchema);

  it('accepts valid 64-character hex token from email verification', () => {
    const validToken = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(pipe.transform({ token: validToken })).toEqual({ token: validToken });
  });

  it('accepts valid token between 20 and 200 characters', () => {
    const token = '12345678901234567890'; // 20 chars
    expect(pipe.transform({ token })).toEqual({ token });
  });

  it('rejects tokens shorter than 20 characters', () => {
    expect(() => pipe.transform({ token: 'short-token' })).toThrow(BadRequestException);
  });

  it('rejects tokens longer than 200 characters', () => {
    const longToken = 'a'.repeat(201);
    expect(() => pipe.transform({ token: longToken })).toThrow(BadRequestException);
  });

  it('rejects missing token field', () => {
    expect(() => pipe.transform({})).toThrow(BadRequestException);
  });

  it('rejects non-string token types', () => {
    expect(() => pipe.transform({ token: 12345678901234567890 })).toThrow(BadRequestException);
    expect(() => pipe.transform({ token: null })).toThrow(BadRequestException);
  });
});
