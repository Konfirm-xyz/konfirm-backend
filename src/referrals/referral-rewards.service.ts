import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { pool } from '../db/pool';

// Mirrors the referred merchant's trial shape (see auth.service.ts) but
// time-only, no volume cap — this is a reward for a real result already
// delivered, not a further trial to ration.
const REWARD_DAYS = 30;

// Reduces whatever the referrer's CURRENT rate is (not a fixed absolute
// number), so an already-negotiated merchant's discount stays proportional
// rather than accidentally overriding a custom rate with a generic one.
const REWARD_DISCOUNT_DIVISOR = 2;

// Triggers only on the referred merchant's real activation (a genuine paid
// payment), never on mere signup -- gating the reward on this is what
// makes referral-farming via empty signups pointless. In-process @Cron(),
// same reasoning as ChannelKeeperService (x402/channel-keeper.service.ts):
// this is small, tightly coupled to the same Postgres pool the api service
// already owns, and a separate service would just reproduce the
// backup-cron shared-railway.json class of bug for no real benefit.
@Injectable()
export class ReferralRewardsService {
  private readonly logger = new Logger(ReferralRewardsService.name);

  @Cron('*/5 * * * *')
  async sweep(): Promise<void> {
    try {
      // Atomic claim: only a referral row that's still reward_granted_at
      // IS NULL gets claimed, and the UPDATE...RETURNING makes "claim it"
      // and "read whether I actually won the race" the same operation --
      // two overlapping sweeps can never both grant the same referral's
      // reward twice.
      const { rows: claimed } = await pool.query<{ id: string; referrer_id: string }>(
        `WITH activated AS (
           SELECT r.id, r.referrer_id
           FROM referrals r
           WHERE r.reward_granted_at IS NULL
             AND EXISTS (SELECT 1 FROM payments p WHERE p.merchant_id = r.referred_id AND p.status = 'paid')
         )
         UPDATE referrals
         SET reward_granted_at = NOW()
         WHERE id IN (SELECT id FROM activated)
         RETURNING id, referrer_id`,
      );

      for (const { id, referrer_id: referrerId } of claimed) {
        await pool.query(
          `UPDATE merchants
           SET promo_fee_bps = GREATEST(FLOOR(fee_bps / $2), 0),
               promo_expires_at = NOW() + ($3 * INTERVAL '24 hours'),
               promo_volume_cap_usdc = NULL
           WHERE id = $1`,
          [referrerId, REWARD_DISCOUNT_DIVISOR, REWARD_DAYS],
        );
        this.logger.log(`granted referrer reward to merchant ${referrerId} for referral ${id}`);
      }
    } catch (err) {
      this.logger.error(`referral rewards sweep failed: ${err}`);
    }
  }
}
