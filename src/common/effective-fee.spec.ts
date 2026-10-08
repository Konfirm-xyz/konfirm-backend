import { getEffectiveFeeBps, resolveEffectiveFeeBps } from './effective-fee';
import { pool } from '../db/pool';

// Mirrors reconciler/src/store.rs's #[cfg(test)] mod test exactly -- same
// 7 cases, same reasoning in each comment. If this ever drifts from the
// Rust version, checkout (this file) and the reconciler could compute two
// different fees for the same merchant at the same moment.
describe('resolveEffectiveFeeBps', () => {
  it('uses the base rate with no promo', () => {
    expect(resolveEffectiveFeeBps(10, null, false, null, 0)).toBe(10);
  });

  it('uses the promo rate when active, within time and volume', () => {
    expect(resolveEffectiveFeeBps(10, 0, true, 500, 100)).toBe(0);
  });

  it('falls back to the base rate once the promo has expired, even with volume left', () => {
    expect(resolveEffectiveFeeBps(10, 0, false, 500, 100)).toBe(10);
  });

  it('no longer applies exactly at the volume cap (strictly less-than, not less-than-or-equal)', () => {
    // The 500th dollar itself is charged at the base rate, matching "first
    // $500 free" read the ordinary way (500 dollars have already been
    // covered).
    expect(resolveEffectiveFeeBps(10, 0, true, 500, 500)).toBe(10);
  });

  it('still applies just under the volume cap', () => {
    expect(resolveEffectiveFeeBps(10, 0, true, 499.9, 499)).toBe(0);
  });

  it('has no volume cap for a referrer reward -- applies purely on time', () => {
    // A large existing volume must never disqualify a time-only promo
    // (promoVolumeCapUsdc = null).
    expect(resolveEffectiveFeeBps(10, 5, true, null, 1_000_000)).toBe(5);
  });

  it('uses the base rate regardless of other fields when promoFeeBps is not set', () => {
    // A merchant who was never referred has promoFeeBps = null -- stray
    // non-null time/volume fields (shouldn't happen, but this is the
    // function's actual contract) must not accidentally activate a
    // discount that was never granted.
    expect(resolveEffectiveFeeBps(10, null, true, 500, 0)).toBe(10);
  });
});

// Real Postgres (konfirm_test, see test/env.ts), no mocks -- matches this
// codebase's standing bar for anything touching the promo/fee tables.
describe('getEffectiveFeeBps', () => {
  const merchantEmail = `effective-fee-e2e-${Date.now()}@example.com`;
  let merchantId: string;

  afterAll(async () => {
    await pool.query('DELETE FROM merchants WHERE email = $1', [merchantEmail]);
    await pool.end();
  });

  it('resolves the promo rate for a merchant with an active, within-cap promo', async () => {
    const { rows } = await pool.query(
      `INSERT INTO merchants (email, password_hash, name, fee_bps, promo_fee_bps, promo_expires_at, promo_volume_cap_usdc)
       VALUES ($1, 'x', 'Effective Fee E2E', 10, 0, NOW() + INTERVAL '24 hours', 500)
       RETURNING id`,
      [merchantEmail],
    );
    merchantId = rows[0].id;

    expect(await getEffectiveFeeBps(merchantId)).toBe(0);
  });

  it('falls back to the base rate once the promo has expired', async () => {
    await pool.query('UPDATE merchants SET promo_expires_at = NOW() - INTERVAL \'1 day\' WHERE id = $1', [merchantId]);
    expect(await getEffectiveFeeBps(merchantId)).toBe(10);
  });
});
