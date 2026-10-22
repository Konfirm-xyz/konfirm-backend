import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pool } from '../src/db/pool';
import { resolveTrustProxyHops } from '../src/common/trust-proxy';
import { adminLoginAttempts, LOGIN_MAX_FAILURES, merchantLoginAttempts } from '../src/common/login-attempts';

// The login throttle is 10 per minute. With trust proxy set, that limit must
// apply per real client (the address the proxy reports), not to every user
// behind the same proxy.
describe('rate limits per client behind a proxy (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.getHttpAdapter().getInstance().set('trust proxy', resolveTrustProxyHops({ NODE_ENV: 'production' }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(() => {
    merchantLoginAttempts.clear();
    adminLoginAttempts.clear();
  });

  const login = (forwardedFor: string, email = 'nobody@example.com', path = '/auth/login') =>
    request(app.getHttpServer())
      .post(path)
      .set('X-Forwarded-For', forwardedFor)
      .send({ email, password: 'wrong-password' });

  // Each client targets its own account here: the per-account cap below
  // would otherwise kick in, and this test is about the per-IP tier only.
  it('lets many different clients each make their own attempts', async () => {
    for (let i = 0; i < 15; i++) {
      const res = await login(`10.9.0.${i + 1}`, `nobody-${i}@example.com`);
      expect(res.status).not.toBe(429);
    }
  });

  it('still throttles one client that keeps going', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await login('10.8.0.1')).status);
    }
    expect(statuses).toContain(429);
  });

  // The per-IP tier can't stop guesses spread across many addresses at one
  // account; the per-account cap (common/login-attempts.ts) does.
  it.each(['/auth/login', '/admin/auth/login'])('caps failed attempts at one account across many clients on %s', async (path) => {
    const email = `target-${Date.now()}@example.com`;
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_MAX_FAILURES + 3; i++) {
      statuses.push((await login(`10.7.${i}.1`, email, path)).status);
    }
    expect(statuses.slice(0, LOGIN_MAX_FAILURES).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(LOGIN_MAX_FAILURES).every((s) => s === 429)).toBe(true);
  });
});
