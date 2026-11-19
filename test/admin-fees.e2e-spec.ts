import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pool } from '../src/db/pool';

// Disputed-settlement coverage for these same routes (has_disputed_settlement,
// /admin/fees/disputed's settlement_id) lives in fees.e2e-spec.ts, which
// seeds a real owed fee and a real dispute against testnet. This spec only
// checks the route's own shape/pagination/auth, so it doesn't duplicate that
// heavier seeding.
describe('GET /admin/fees/owed (e2e)', () => {
  let app: INestApplication;
  const adminEmail = `admin-fees-e2e-${Date.now()}@example.com`;
  let adminCookie: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    const passwordHash = await bcrypt.hash('an-admin-password-000', 10);
    await pool.query('INSERT INTO admins (email, password_hash, name) VALUES ($1, $2, $3)', [adminEmail, passwordHash, 'E2E Admin']);

    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: adminEmail, password: 'an-admin-password-000' })
      .expect(200);
    adminCookie = res.headers['set-cookie'][0].split(';')[0];
  });

  afterAll(async () => {
    await pool.query('DELETE FROM admin_actions WHERE admin_id IN (SELECT id FROM admins WHERE email = $1)', [adminEmail]);
    await pool.query('DELETE FROM admins WHERE email = $1', [adminEmail]);
    await app.close();
    await pool.end();
  });

  it('requires an authenticated admin', async () => {
    await request(app.getHttpServer()).get('/admin/fees/owed').expect(401);
  });

  it('returns only owed fees for paid payments, paginated', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/fees/owed')
      .set('Cookie', adminCookie)
      .query({ limit: 10, offset: 0 })
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(10);

    for (const row of res.body) {
      expect(row).toHaveProperty('merchant_id');
      expect(row).toHaveProperty('fee_asset_code');
      expect(row).toHaveProperty('oldest_owed_at');
    }
  });

  it('respects the limit query parameter', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/fees/owed')
      .set('Cookie', adminCookie)
      .query({ limit: 1 })
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(1);
  });
});

// Role scoping: `support` admins keep merchant/payment access but are blocked
// from compliance, treasury, treasury-settlements, and facilitator routes.
describe('admin role scoping (e2e)', () => {
  let app: INestApplication;
  const stamp = Date.now();
  const supportEmail = `admin-support-e2e-${stamp}@example.com`;
  const superEmail = `admin-super-e2e-${stamp}@example.com`;
  const password = 'a-role-scoped-password-0';
  let supportCookie: string;
  let superCookie: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO admins (email, password_hash, name, role) VALUES ($1, $2, $3, $4)', [
      supportEmail,
      passwordHash,
      'Support Admin',
      'support',
    ]);
    await pool.query('INSERT INTO admins (email, password_hash, name, role) VALUES ($1, $2, $3, $4)', [
      superEmail,
      passwordHash,
      'Super Admin',
      'superadmin',
    ]);

    const supportLogin = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: supportEmail, password })
      .expect(200);
    supportCookie = supportLogin.headers['set-cookie'][0].split(';')[0];

    const superLogin = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: superEmail, password })
      .expect(200);
    superCookie = superLogin.headers['set-cookie'][0].split(';')[0];
  });

  afterAll(async () => {
    await pool.query('DELETE FROM admin_actions WHERE admin_id IN (SELECT id FROM admins WHERE email = ANY($1))', [
      [supportEmail, superEmail],
    ]);
    await pool.query('DELETE FROM admins WHERE email = ANY($1)', [[supportEmail, superEmail]]);
    await app.close();
    await pool.end();
  });

  it('blocks a support admin from compliance routes', async () => {
    await request(app.getHttpServer())
      .get('/admin/compliance/blocked-addresses')
      .set('Cookie', supportCookie)
      .expect(401);
    await request(app.getHttpServer())
      .post('/admin/compliance/blocked-addresses')
      .set('Cookie', supportCookie)
      .send({ stellar_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', reason: 'role test' })
      .expect(401);
    await request(app.getHttpServer())
      .delete('/admin/compliance/blocked-addresses/00000000-0000-0000-0000-000000000000')
      .set('Cookie', supportCookie)
      .expect(401);
  });

  it('blocks a support admin from treasury, treasury-settlements, and facilitator routes', async () => {
    await request(app.getHttpServer()).get('/admin/treasury/status').set('Cookie', supportCookie).expect(401);
    await request(app.getHttpServer()).get('/admin/treasury/settlements').set('Cookie', supportCookie).expect(401);
    await request(app.getHttpServer()).get('/admin/facilitator/status').set('Cookie', supportCookie).expect(401);
    await request(app.getHttpServer()).post('/admin/facilitator/resume').set('Cookie', supportCookie).expect(401);
  });

  it('still lets a support admin reach merchant and payment routes', async () => {
    await request(app.getHttpServer()).get('/admin/merchants').set('Cookie', supportCookie).expect(200);
    await request(app.getHttpServer()).get('/admin/payments').set('Cookie', supportCookie).expect(200);
  });

  it('lets a superadmin reach the scoped routes', async () => {
    await request(app.getHttpServer())
      .get('/admin/compliance/blocked-addresses')
      .set('Cookie', superCookie)
      .expect(200);
    await request(app.getHttpServer()).get('/admin/facilitator/status').set('Cookie', superCookie).expect(200);
  });
});
