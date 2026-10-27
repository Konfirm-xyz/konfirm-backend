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