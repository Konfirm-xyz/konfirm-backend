import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ReconcilerWatchdogService } from './observability/reconciler-watchdog.service';
import { FeesModule } from './fees/fees.module';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './observability/all-exceptions.filter';
import { AuthModule } from './auth/auth.module';
import { LinksModule } from './links/links.module';
import { SessionsModule } from './sessions/sessions.module';
import { PaymentsModule } from './payments/payments.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { DepositsModule } from './deposits/deposits.module';
import { AdminAuthModule } from './admin-auth/admin-auth.module';
import { AdminModule } from './admin/admin.module';
import { X402Module } from './x402/x402.module';
import { ReferralsModule } from './referrals/referrals.module';
import { FacilitatorModule } from './facilitator/facilitator.module';
import { BazaarModule } from './bazaar/bazaar.module';

const isProd = process.env.NODE_ENV === 'production';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        // Human-readable in dev, real newline-delimited JSON in prod — same
        // structured fields either way (level, time, req.id, msg), just a
        // different transport rendering them.
        transport: isProd ? undefined : { target: 'pino-pretty', options: { colorize: true, singleLine: true } },
        // pino-http logs request headers by default, which would put the
        // raw session JWT (an httpOnly cookie) and any Bearer tokens
        // straight into the log stream — fixing observability by creating
        // a credential leak would be a net loss, not a fix.
        redact: {
          paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
          censor: '[redacted]',
        },
        // The activity/checkout/cash-out pages poll these every 2-3s while
        // open — logging every poll at request/response granularity would
        // drown out everything else within minutes of anyone leaving a tab
        // open. Errors on these routes still surface normally; this only
        // suppresses the routine, expected, high-frequency success case.
        autoLogging: {
          ignore: (req) =>
            /\/payments\/mine/.test(req.url ?? '') ||
            /\/links\/[^/]+\/sessions\/\d+/.test(req.url ?? '') ||
            /\/(withdrawals|deposits)\/status/.test(req.url ?? ''),
        },
      },
    }),
    // A global default (60/min per IP) covers every route with no extra
    // work; auth and payment-adjacent routes tighten this individually
    // with @Throttle() since brute-forcing a password or hammering an
    // external anchor/RPC needs a much lower ceiling than reading a public
    // link.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    // Backs the channel keeper's @Cron() sweep (see x402/channel-keeper.service.ts)
    // — deliberately in-process rather than a separate Railway service; see that
    // file's module-level comment for why.
    ScheduleModule.forRoot(),
    AuthModule,
    LinksModule,
    SessionsModule,
    PaymentsModule,
    WithdrawalsModule,
    DepositsModule,
    AdminAuthModule,
    AdminModule,
    X402Module,
    ReferralsModule,
    FacilitatorModule,
    BazaarModule,
    FeesModule,
  ],
  providers: [
    ReconcilerWatchdogService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
