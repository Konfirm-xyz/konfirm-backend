import { BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';

// Zod validation at every API boundary — the master-prompt invariant, not
// class-validator decorator ceremony. One reusable pipe, one schema per
// endpoint.
//
// `BadRequestException(result.error.flatten())` used to be passed a plain
// object (`{ formErrors, fieldErrors }`) instead of a string. Nest's
// HttpException uses a non-string response body as-is rather than wrapping
// it, so the resulting response had no `message` field at all -- every
// validation failure through this pipe (signup's stellar_base_address among
// them) came back as `{ statusCode: 400, formErrors: [...], fieldErrors:
// {...} }` with `res.body.message` silently `undefined`. A second,
// never-wired-in pipe (src/common/zod-validation.pipe.ts, added by #49 for
// admin pagination params but never imported anywhere) already had the
// correct shape; this inlines that same readable-message logic into the
// pipe every controller in this app actually imports, rather than leaving
// a second copy to drift again.
export class ZodValidationPipe implements PipeTransform {
  constructor(private schema: ZodSchema) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => {
          const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
          return `${path}${issue.message}`;
        })
        .join('; ');
      throw new BadRequestException(message || 'invalid request');
    }
    return result.data;
  }
}
