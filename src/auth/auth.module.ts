import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { MAILER, mailerFromEnv } from '../mail/mailer';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, { provide: MAILER, useFactory: () => mailerFromEnv() }],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
