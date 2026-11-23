import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import { ZodError, ZodType } from 'zod';

/**
 * Validates an incoming value against a Zod schema and returns the parsed
 * (and coerced) result. Throws a 400 BadRequestException with a readable
 * message when validation fails, so raw driver errors never surface as 500s.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        const message = error.issues
          .map((issue) => {
            const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
            return `${path}${issue.message}`;
          })
          .join('; ');
        throw new BadRequestException(message || 'invalid request');
      }
      throw new BadRequestException('invalid request');
    }
  }
}
