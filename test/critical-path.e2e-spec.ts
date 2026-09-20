import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { Transaction, TransactionBuilder, Networks } from '@stellar/stellar-sdk';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pool } from '../src/db/pool';

// The one critical-path test: signup -> create a payment link -> reserve a
// session -> prepare a real, well-formed transaction. This is as far as an
// automated test can honestly go — the actual payment requires a wallet
// holding a private key to sign, which is a human-and-a-browser problem
// (see this project's own testing history), not something CI can do.
describe('critical path: signup -> link -> session -> prepare-tx (e2e)', () => {
  let app: INestApplication;
  const email = `e2e-${Date.now()}@example.com`;
  const stellarAddress = 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB';
  const payerAddress = 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL';
  let sessionCookie: string;
  let linkId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    // Children before parent — link_sessions -> payments -> links -> merchants.
    await pool.query(
      `DELETE FROM link_sessions WHERE link_id IN (SELECT id FROM links WHERE merchant_id = (SELECT id FROM merchants WHERE email = $1))`,
      [email],
    );
    await pool.query(
      `DELETE FROM payments WHERE merchant_id = (SELECT id FROM merchants WHERE email = $1)`,
      [email],
    );
    await pool.query(`DELETE FROM links WHERE merchant_id = (SELECT id FROM merchants WHERE email = $1)`, [email]);
    await pool.query('DELETE FROM merchants WHERE email = $1', [email]);
    await app.close();
    await pool.end();
  });

  it('rejects link creation with no session at all', async () => {
    await request(app.getHttpServer())
      .post('/links')
      .send({ amount_usdc: '5.00', currency: 'XLM' })
      .expect(401);
  });

  it('signs up a merchant and receives a session cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email, password: 'a-real-password-000', name: 'E2E Merchant', stellar_base_address: stellarAddress })
      .expect(201);

    expect(res.body.merchant.email).toBe(email);
    const rawCookie = res.headers['set-cookie']?.[0];
    expect(rawCookie).toBeDefined();
    sessionCookie = rawCookie.split(';')[0];
  });

  it('creates a payment link, ignoring any client-supplied merchant_id', async () => {
    const res = await request(app.getHttpServer())
      .post('/links')
      .set('Cookie', sessionCookie)
      .send({
        amount_usdc: '5.00',
        currency: 'XLM',
        description: 'e2e test link',
        merchant_id: '00000000-0000-0000-0000-000000000000', // must be ignored
      })
      .expect(201);

    expect(res.body.merchant_id).not.toBe('00000000-0000-0000-0000-000000000000');
    expect(res.body.currency).toBe('XLM');
    linkId = res.body.id;
  });

  it('serves the public projection a checkout page relies on, including the real fee preview', async () => {
    const res = await request(app.getHttpServer()).get(`/links/${linkId}/public`).expect(200);
    expect(res.body.stellar_base_address).toBe(stellarAddress);
    expect(res.body.amount_usdc).toBe('5.0000000');
    // Default merchant fee_bps is 10 (0.1%, migration 001) — 5.00 * 10 / 10000.
    expect(res.body.fee_usdc).toBe('0.0050000');
  });

  it('reserves a session against the link', async () => {
    await request(app.getHttpServer())
      .post(`/links/${linkId}/sessions`)
      .send({ muxed_id: '123456789' })
      .expect(201);
  });

  it('rejects a second reservation of the same muxed_id with 409, not a 500', async () => {
    await request(app.getHttpServer())
      .post(`/links/${linkId}/sessions`)
      .send({ muxed_id: '123456789' })
      .expect(409);
  });

  it('prepares a real, well-formed transaction for the payer to sign, splitting merchant + fee legs', async () => {
    const res = await request(app.getHttpServer())
      .get('/payments/prepare-tx')
      .query({ linkId, muxed_id: '123456789', payer: payerAddress })
      .expect(200);

    expect(res.body.xdr).toEqual(expect.any(String));
    expect(res.body.network_passphrase).toBe(Networks.TESTNET);

    // Decode it for real rather than trusting the string blindly — this is
    // exactly the kind of check that would have caught the muxed-address
    // vs. memo routing bug earlier in this project's life, automatically,
    // on every run, instead of needing a human to notice a wallet crash.
    // Two operations, not one: additive fee collection means the payer's
    // single signed transaction pays the merchant the full link amount AND
    // Konfirm's fee, atomically — see payments.service.ts's prepareTx.
    const tx = TransactionBuilder.fromXDR(res.body.xdr, Networks.TESTNET) as Transaction;
    expect(tx.operations).toHaveLength(2);
    expect(tx.operations[0].type).toBe('payment');
    expect((tx.operations[0] as any).destination).toBe(stellarAddress);
    expect((tx.operations[0] as any).amount).toBe('5.0000000');
    expect(tx.operations[1].type).toBe('payment');
    expect((tx.operations[1] as any).destination).toBe(process.env.PLATFORM_FEE_ADDRESS);
    expect((tx.operations[1] as any).amount).toBe('0.0050000');
    expect(tx.memo.type).toBe('id');
    expect(tx.memo.value).toBe('123456789');
  });

  it('builds a spec-correct SEP-7 QR payment URI for the same link', async () => {
    await request(app.getHttpServer())
      .post(`/links/${linkId}/sessions`)
      .send({ muxed_id: '987654321' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/payments/pay-uri')
      .query({ linkId, muxed_id: '987654321' })
      .expect(200);

    expect(res.body.uri).toContain('web+stellar:pay?');
    expect(res.body.uri).toContain(`destination=${stellarAddress}`);
    expect(res.body.uri).toContain('memo=987654321');
    expect(res.body.uri).toContain('memo_type=MEMO_ID');
  });
});
