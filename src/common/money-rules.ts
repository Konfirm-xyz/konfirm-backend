// The platform fee rule, in one place (docs/architecture/target-architecture.md,
// section 3.1). The same rule is in reconciler/src/money.rs. Both are checked
// against money-rules/vectors.json, so a change here has to change the vectors.
//
// Amounts are exact integers in stroops (1e-7 of the asset), never floats. Floats
// drift across many payments, and a settlement must pay exactly what was owed.

const STROOPS_PER_UNIT = 10_000_000n;

export function toStroops(decimal: string): bigint {
  const [whole, frac = ''] = decimal.split('.');
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt((frac + '0000000').slice(0, 7));
}

export function fromStroops(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_UNIT;
  const frac = (stroops % STROOPS_PER_UNIT).toString().padStart(7, '0');
  return `${whole}.${frac}`;
}

// fee = floor(amount * bps / 10000) in stroops, raised to floor when positive.
// Zero amount or zero rate charges nothing, so a promo at 0 bps stays free even
// with a floor configured.
export function feeStroops(amount: bigint, bps: number, floor: bigint = 0n): bigint {
  if (amount <= 0n || bps <= 0) return 0n;
  const fee = (amount * BigInt(bps)) / 10_000n;
  return fee < floor ? floor : fee;
}

export function owedFee(amount: string, bps: number, floor = '0'): string {
  return fromStroops(feeStroops(toStroops(amount), bps, toStroops(floor)));
}

// The configured floor, in asset units (PLATFORM_FEE_FLOOR). Unset means no
// floor, which is today's behaviour. The reconciler reads the same variable.
export function platformFeeFloor(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLATFORM_FEE_FLOOR || '0';
}
