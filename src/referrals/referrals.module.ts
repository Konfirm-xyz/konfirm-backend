import { Module } from '@nestjs/common';
import { ReferralRewardsService } from './referral-rewards.service';
import { MAILER, mailerFromEnv } from '../mail/mailer';

@Module({
  providers: [ReferralRewardsService, { provide: MAILER, useFactory: () => mailerFromEnv() }],
})
export class ReferralsModule {}
