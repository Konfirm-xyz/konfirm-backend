import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnchorSessionCleanupService } from '../common/anchor-session-cleanup.service';
import { WithdrawalsController } from './withdrawals.controller';
import { WithdrawalsService } from './withdrawals.service';

@Module({
  imports: [AuthModule],
  controllers: [WithdrawalsController],
  providers: [WithdrawalsService, AnchorSessionCleanupService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
