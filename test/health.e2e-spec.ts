import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pool } from '../src/db/pool';

describe('GET /health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('returns 200 when the database answers', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok' });
  });

  it('returns 503 when the database query fails', async () => {
    jest.spyOn(pool, 'query').mockImplementation((() => Promise.reject(new Error('connection refused'))) as never);
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(503);
  });

  it('is not rate limited', async () => {
    for (let i = 0; i < 65; i++) {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).not.toBe(429);
    }
  });
});
