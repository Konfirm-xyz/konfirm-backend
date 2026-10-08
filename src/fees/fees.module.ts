import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';
import { FeesSweeperService } from './fees-sweeper.service';
import { AdminFeesController } from '../admin/admin-fees.controller';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';

@Module({
  imports: [AuthModule, AdminAuthModule],
  controllers: [FeesController, AdminFeesController],
  providers: [FeesService, FeesSweeperService],
  exports: [FeesService],
})
export class FeesModule {}
