import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { initSentry } from './observability/sentry';
import { installProcessHandlers } from './observability/process-handlers';
import { resolveTrustProxyHops } from './common/trust-proxy';
import { assertSeparateHotKeys } from './common/facilitator-signer';
import { assertNetworkReady } from './common/stellar-network';
import { buildCorsMiddleware } from './common/cors';

async function bootstrap() {
  // Refuse to start if the facilitator, deployer, and fee keys overlap.
  assertSeparateHotKeys();
  assertNetworkReady();
  initSentry();
  // After initSentry so Sentry's own handlers capture first; these add the
  // log line and the deliberate exit whether or not SENTRY_DSN is set.
  installProcessHandlers();
  // bufferLogs holds anything logged before the pino logger takes over
  // (below) and replays it through pino instead of dropping it or falling
  // back to Nest's plain console logger for just those first few lines.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(cookieParser());
  app.use(helmet());
  app.use(compression());
  app.use(buildCorsMiddleware());
  // Express auto-generates ETags for every response by default, which lets
  // a browser skip re-fetching via a conditional request — a second,
  // independent caching path beyond Cache-Control that would reproduce the
  // exact same "fix didn't take" symptom on its own.
  app.getHttpAdapter().getInstance().set('etag', false);
  // Rate limits key on req.ip, so this must match the real proxy chain.
  app.getHttpAdapter().getInstance().set('trust proxy', resolveTrustProxyHops());

  // ---------------------------------------------------------------------------
  // OpenAPI / Swagger — served at /api-docs in non-production environments.
  // The spec is always generated (useful for tooling); the UI is gated so it
  // never surfaces in a live deployment by accident.
  // ---------------------------------------------------------------------------
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Konfirm API')
    .setDescription(
      'Non-custodial payment processor built on Stellar. ' +
      'Merchant routes require a `konfirm_session` cookie (httpOnly JWT). ' +
      'Admin routes require a `konfirm_admin_session` cookie.',
    )
    .setVersion('1.0')
    .addTag('Auth', 'Merchant sign-up, login, logout, and session management')
    .addTag('Links', 'Payment link creation and public projection')
    .addTag('Sessions', 'Muxed-ID reservation against a payment link')
    .addTag('Payments', 'Transaction building, SEP-7 URIs, and merchant payment history')
    .addTag('Withdrawals', 'SEP-10/SEP-24 fiat off-ramp (cash-out to bank)')
    .addTag('Fees', 'Platform fee settlement for merchants')
    .addTag('Admin Auth', 'Admin identity — separate from merchant auth')
    .addTag('Admin', 'Admin resource endpoints (merchants, payments, compliance, reconciler, …)')
    .addTag('Admin Fees', 'Admin view of owed and disputed fee settlements')
    .addTag('Bazaar', 'x402 facilitator/resource discovery manifest and submissions')
    .addTag('x402', 'x402 payment facilitator (verify and settle)')
    .addTag('Deposits', 'Testnet-only SEP-24 deposit / faucet (gated by ENABLE_TESTNET_FAUCET)')
    .addCookieAuth('konfirm_session', { type: 'apiKey', in: 'cookie', name: 'konfirm_session' }, 'merchant-session')
    .addCookieAuth('konfirm_admin_session', { type: 'apiKey', in: 'cookie', name: 'konfirm_admin_session' }, 'admin-session')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);

  // Only mount the interactive UI outside production — the JSON spec is
  // generated regardless so CI/tooling can consume it without a running server.
  if (process.env.NODE_ENV !== 'production') {
    SwaggerModule.setup('api-docs', app, document, {
      swaggerOptions: {
        // Persist auth across page reloads during local development.
        persistAuthorization: true,
        // Collapse all operation groups by default for readability.
        docExpansion: 'list',
        // Show request duration in the UI.
        displayRequestDuration: true,
      },
      customSiteTitle: 'Konfirm API Docs',
    });
  }

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`konfirm-backend listening on :${port}`);
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log(`Swagger UI available at http://localhost:${port}/api-docs`);
  }
}
bootstrap();
