import { pool } from '../db/pool';

// Pure decision logic, line-for-line mirror of
// reconciler/src/store.rs's resolve_effective_fee_bps -- must stay in sync
// with that function. Kept pure and separate from the SQL below for the
// same reason the Rust version is: unit-testable with no database or
// date/time handling here at all (promoTimeValid is a plain bool already
// resolved by Postgres's own NOW(), not a timestamp this function parses).
export function resolveEffectiveFeeBps(
  baseFeeBps: number,
  promoFeeBps: number | null,
  promoTimeValid: boolean,
  promoVolumeCapUsdc: number | null,
  volumeSoFarUsdc: number,
): number {
  if (promoFeeBps !== null && promoTimeValid && (promoVolumeCapUsdc === null || volumeSoFarUsdc < promoVolumeCapUsdc)) {
    return promoFeeBps;
  }
  return baseFeeBps;
}

// Same SQL shape as reconciler/src/store.rs's effective_fee_bps -- must
// match that query. Checkout (prepareTx) needs this to know the exact fee
// to charge *before* building a transaction; the reconciler needs it to
// know whether a fee leg is expected when matching a payment. Two
// languages, one query, kept side by side rather than shared, since there
// is no existing cross-language shared-query mechanism in this codebase
// (see asset.ts's USDC_TESTNET_ISSUER/EURC_TESTNET_ISSUER for the same
// duplicated-but-must-match convention).
export async function getEffectiveFeeBps(merchantId: string): Promise<number> {
  const { rows } = await pool.query<{
    fee_bps: number;
    promo_fee_bps: number | null;
    promo_time_valid: boolean;
    promo_volume_cap_usdc: string | null;
    volume_so_far_usdc: string;
  }>(
    `SELECT
        fee_bps,
        promo_fee_bps,
        (promo_expires_at IS NOT NULL AND promo_expires_at > NOW()) AS promo_time_valid,
        promo_volume_cap_usdc,
        COALESCE((SELECT SUM(amount_usdc) FROM payments WHERE merchant_id = $1 AND status = 'paid'), 0) AS volume_so_far_usdc
     FROM merchants WHERE id = $1`,
    [merchantId],
  );
  if (rows.length === 0) throw new Error(`getEffectiveFeeBps: merchant ${merchantId} not found`);
  const row = rows[0];
  return resolveEffectiveFeeBps(
    row.fee_bps,
    row.promo_fee_bps,
    row.promo_time_valid,
    row.promo_volume_cap_usdc === null ? null : Number(row.promo_volume_cap_usdc),
    Number(row.volume_so_far_usdc),
  );
}
