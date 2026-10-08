import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pool } from '../src/db/pool';
import { resolveTrustProxyHops } from '../src/common/trust-proxy';

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

  const login = (forwardedFor: string) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', forwardedFor)
      .send({ email: 'nobody@example.com', password: 'wrong-password' });

  it('lets many different clients each make their own attempts', async () => {
    for (let i = 0; i < 15; i++) {
      const res = await login(`10.9.0.${i + 1}`);
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
});
