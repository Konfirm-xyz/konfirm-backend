import { z } from 'zod';

export const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export function nonNegativeIntegerStringSchema(maxValue: bigint, field: string) {
  return z
    .string()
    .regex(/^\d+$/, `${field} must be a non-negative integer string`)
    .refine((value) => {
      // zod doesn't short-circuit between a failed .regex() check and the
      // .refine() that follows it — both still run, so BigInt() here must
      // tolerate input the regex already rejected (e.g. "not-a-number")
      // rather than throw a raw SyntaxError past safeParse and turn a 400
      // into an unhandled 500. The regex issue is already reported either way.
      try {
        return BigInt(value) <= maxValue;
      } catch {
        return true;
      }
    }, `${field} exceeds its supported range`);
}

// Pagination query params (limit/offset) arrive as optional strings from
// @Query() and used to go straight into `Number(x)` — a non-numeric value
// (?limit=abc) becomes NaN, which Postgres then rejects as a raw 500
// instead of a 400, or worse, a validation error the caller never sees
// cleanly. These are read-only list endpoints, so garbage input is just
// treated as "not provided" (the endpoint's own default applies) rather
// than rejecting the whole request outright.
export function parsePaginationInt(value?: string): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

// Route params and query strings that end up in a UUID column used to be
// passed to Postgres as-is: a malformed value (e.g. /links/abc/public) makes
// the uuid cast throw, which surfaces as a 500 and a Sentry capture instead
// of a clean 404/400. Callers use this to reject the value before querying.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function nonNegativeDecimalStringSchema(label: string, scale: number, maxScaledValue: bigint) {
  return z
    .string()
    .regex(new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`), `${label} must have at most ${scale} decimal places`)
    .refine((value) => {
      // Same reasoning as nonNegativeIntegerStringSchema above: this runs
      // even when the regex check just failed, so malformed input must not
      // throw here.
      try {
        const [whole, fraction = ''] = value.split('.');
        const scaledValue = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
        return scaledValue <= maxScaledValue;
      } catch {
        return true;
      }
    }, `${label} exceeds its supported range`);
}