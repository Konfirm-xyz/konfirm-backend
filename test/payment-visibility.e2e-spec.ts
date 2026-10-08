import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pool } from '../src/db/pool';

// Who can see which payments. Each rule here was a real exposure before:
// the by-address routes returned any merchant's sales to anyone, and the
// checkout poll scanned that same list.
describe('payment visibility (e2e)', () => {
  let app: INestApplication;
  const stamp = Date.now();
  const emailA = `vis-a-${stamp}@example.com`;
  const emailB = `vis-b-${stamp}@example.com`;
  const addressA = 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB';
  const addressB = 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL';
  const muxedA = '7000000000000000001';
  const muxedB = '7000000000000000002';
  let cookieA: string;
  let cookieB: string;
  let linkA: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
    const http = app.getHttpServer();

    const a = await request(http)
      .post('/auth/signup')
      .send({ email: emailA, password: 'correct horse', name: 'Merchant A', stellar_base_address: addressA })
      .expect(201);
    cookieA = a.headers['set-cookie'][0].split(';')[0];

    const b = await request(http)
      .post('/auth/signup')
      .send({ email: emailB, password: 'correct horse', name: 'Merchant B', stellar_base_address: addressB })
      .expect(201);
    cookieB = b.headers['set-cookie'][0].split(';')[0];

    const link = await request(http)
      .post('/links')
      .set('Cookie', cookieA)
      .send({ amount_usdc: '10', currency: 'USDC', description: 'Invoice 42' })
      .expect(201);
    linkA = link.body.id;

    await request(http).post(`/links/${linkA}/sessions`).send({ muxed_id: muxedA }).expect(201);

    // Stands in for the reconciler recording a matched payment.
    await pool.query(
      `INSERT INTO payments (merchant_id, link_id, muxed_id, muxed_address, payer_address,
          asset_code, amount_usdc, fee_usdc, net_usdc, channel, status, paging_token, tx_hash, ledger_sequence)
       SELECT id, $2::uuid, $3::bigint, $4, $5, 'USDC', 10, 0, 10, 'hosted_checkout', 'paid', $6, $7, 1
       FROM merchants WHERE email = $1`,
      [emailA, linkA, muxedA, addressA, addressB, `vis-paging-${stamp}`, `vis-tx-${stamp}`],
    );
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM payments WHERE merchant_id IN (SELECT id FROM merchants WHERE email IN ($1, $2))`,
      [emailA, emailB],
    );
    await pool.query(
      `DELETE FROM link_sessions WHERE merchant_id IN (SELECT id FROM merchants WHERE email IN ($1, $2))`,
      [emailA, emailB],
    );
    await pool.query(
      `DELETE FROM links WHERE merchant_id IN (SELECT id FROM merchants WHERE email IN ($1, $2))`,
      [emailA, emailB],
    );
    await pool.query('DELETE FROM merchants WHERE email IN ($1, $2)', [emailA, emailB]);
    await app.close();
    await pool.end();
  });

  it('no longer serves any merchant\'s payments by Stellar address', async () => {
    await request(app.getHttpServer()).get(`/payments/by-merchant/${addressA}`).expect(404);
    await request(app.getHttpServer()).get(`/payments/pending-by-merchant/${addressA}`).expect(404);
  });

  it('requires a session for the merchant dashboard', async () => {
    await request(app.getHttpServer()).get('/payments/mine').expect(401);
    await request(app.getHttpServer()).get('/payments/mine/pending').expect(401);
  });

  it('shows a merchant their own payments and nobody else\'s', async () => {
    const own = await request(app.getHttpServer()).get('/payments/mine').set('Cookie', cookieA).expect(200);
    expect(own.body.map((p: { tx_hash: string }) => p.tx_hash)).toContain(`vis-tx-${stamp}`);

    const other = await request(app.getHttpServer()).get('/payments/mine').set('Cookie', cookieB).expect(200);
    expect(other.body).toEqual([]);
  });

  it('gives the payer their own session status, with only that payment', async () => {
    const res = await request(app.getHttpServer()).get(`/links/${linkA}/sessions/${muxedA}`).expect(200);
    expect(res.body.confirmed).toBe(true);
    expect(res.body.payment.tx_hash).toBe(`vis-tx-${stamp}`);
    expect(res.body.payment).not.toHaveProperty('payer_address');
    expect(res.body.payment).not.toHaveProperty('status');
  });

  it('reports a reserved-but-unpaid session as not confirmed', async () => {
    await request(app.getHttpServer()).post(`/links/${linkA}/sessions`).send({ muxed_id: muxedB }).expect(201);
    const res = await request(app.getHttpServer()).get(`/links/${linkA}/sessions/${muxedB}`).expect(200);
    expect(res.body).toEqual({ confirmed: false, payment: null });
  });

  it('404s for an unknown session, and rejects a malformed id', async () => {
    await request(app.getHttpServer()).get(`/links/${linkA}/sessions/9999999999999999`).expect(404);
    await request(app.getHttpServer()).get(`/links/${linkA}/sessions/not-a-number`).expect(400);
  });
});
