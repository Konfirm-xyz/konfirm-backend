import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder, BASE_FEE } from '@stellar/stellar-sdk';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pool } from '../src/db/pool';
import { FeesService } from '../src/fees/fees.service';
import { ReconcilerWatchdogService } from '../src/observability/reconciler-watchdog.service';

// Fee settlement against real testnet. The merchant's key is generated here
// and funded by Friendbot, so the test can sign as the merchant the way
// Freighter would. Konfirm's side (build, verify hash, submit, confirm) runs
// unchanged.
describe('fee settlement (e2e, testnet)', () => {
  let app: INestApplication;
  const stamp = Date.now();
  const email = `fees-${stamp}@example.com`;
  const merchantKey = Keypair.random();
  const otherEmail = `fees-other-${stamp}@example.com`;
  const otherKey = Keypair.random();
  const adminEmail = `fees-admin-${stamp}@example.com`;
  let cookie: string;
  let otherCookie: string;
  let adminCookie: string;
  let merchantId: string;
  let otherMerchantId: string;

  const seedOwed = async (paging: string, raw: string, ownerId = merchantId) => {
    await pool.query(
      `INSERT INTO payments (merchant_id, muxed_id, muxed_address, payer_address, asset_code, amount_usdc, fee_usdc,
          net_usdc, channel, status, paging_token, tx_hash, ledger_sequence, fee_status, fee_owed_raw, fee_asset_code)
       VALUES ($1, $2, $3, $4, 'XLM', 100, 0, 100, 'hosted_checkout', 'paid', $5, $6, 1, 'owed', $7, 'XLM')`,
      [ownerId, Math.floor(Math.random() * 1e12), merchantKey.publicKey(), merchantKey.publicKey(), paging, `tx-${paging}`, raw],
    );
  };

  beforeAll(async () => {
    // Friendbot is slow under full-suite load. Give setup room.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    for (const kp of [merchantKey, otherKey]) {
      const res = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
      if (!res.ok) throw new Error(`friendbot failed: ${res.status}`);
    }

    const signup = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email, password: 'fees-password-1', name: 'Fees', stellar_base_address: merchantKey.publicKey() })
      .expect(201);
    cookie = signup.headers['set-cookie'][0].split(';')[0];
    merchantId = signup.body.merchant.id;

    const other = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email: otherEmail, password: 'fees-password-2', name: 'Other', stellar_base_address: otherKey.publicKey() })
      .expect(201);
    otherCookie = other.headers['set-cookie'][0].split(';')[0];
    otherMerchantId = other.body.merchant.id;

    const adminHash = await bcrypt.hash('fees-admin-password-1', 10);
    await pool.query('INSERT INTO admins (email, password_hash, name) VALUES ($1, $2, $3)', [adminEmail, adminHash, 'Fees Admin']);
    const admin = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: adminEmail, password: 'fees-admin-password-1' })
      .expect(200);
    adminCookie = admin.headers['set-cookie'][0].split(';')[0];
  }, 90_000);

  afterAll(async () => {
    await pool.query('DELETE FROM payments WHERE merchant_id IN (SELECT id FROM merchants WHERE email IN ($1, $2))', [email, otherEmail]);
    await pool.query('DELETE FROM fee_settlements WHERE merchant_id IN (SELECT id FROM merchants WHERE email IN ($1, $2))', [email, otherEmail]);
    await pool.query('DELETE FROM merchants WHERE email IN ($1, $2)', [email, otherEmail]);
    await pool.query('DELETE FROM admins WHERE email = $1', [adminEmail]);
    await app.close();
    await pool.end();
  }, 90_000);

  it('shows the merchant what is owed', async () => {
    await seedOwed(`fee-a-${stamp}`, '0.5000000');
    await seedOwed(`fee-b-${stamp}`, '0.2500000');
    const res = await request(app.getHttpServer()).get('/fees/owed').set('Cookie', cookie).expect(200);
    expect(res.body.totals).toEqual([
      expect.objectContaining({ asset_code: 'XLM', amount: '0.7500000', payments: 2 }),
    ]);
  });

  it('builds one settlement, returns the same one on a second request, and submits it signed by the merchant', async () => {
    const first = await request(app.getHttpServer()).post('/fees/settlements').set('Cookie', cookie).expect(201);
    const second = await request(app.getHttpServer()).post('/fees/settlements').set('Cookie', cookie).expect(201);
    expect(second.body.settlement_id).toBe(first.body.settlement_id);

    const claimed = await pool.query(`SELECT COUNT(*)::int AS n FROM payments WHERE fee_settlement_id = $1 AND fee_status = 'claimed'`, [first.body.settlement_id]);
    expect(claimed.rows[0].n).toBe(2);

    const tx = TransactionBuilder.fromXDR(first.body.unsigned_xdr, Networks.TESTNET);
    tx.sign(merchantKey);
    const submitted = await request(app.getHttpServer())
      .post(`/fees/settlements/${first.body.settlement_id}/submit`)
      .set('Cookie', cookie)
      .send({ signed_xdr: tx.toXDR() })
      .expect(201);
    expect(submitted.body.ok).toBe(true);

    const settled = await pool.query(`SELECT COUNT(*)::int AS n FROM payments WHERE fee_settlement_id = $1 AND fee_status = 'settled'`, [first.body.settlement_id]);
    expect(settled.rows[0].n).toBe(2);
    const row = await pool.query('SELECT status FROM fee_settlements WHERE id = $1', [first.body.settlement_id]);
    expect(row.rows[0].status).toBe('confirmed');
  }, 60_000);

  it('has nothing left to settle afterwards', async () => {
    await request(app.getHttpServer()).post('/fees/settlements').set('Cookie', cookie).expect(404);
  });

  it('signs and submits a partial settlement while keeping the remainder owed', async () => {
    await seedOwed(`fee-partial-a-${stamp}`, '0.5000000');
    await seedOwed(`fee-partial-b-${stamp}`, '0.2500000');
    const built = await request(app.getHttpServer())
      .post('/fees/settlements')
      .set('Cookie', cookie)
      .send({ amount: '0.6000000', asset_code: 'XLM' })
      .expect(201);

    expect(built.body.totals).toEqual([
      expect.objectContaining({ asset_code: 'XLM', amount: '0.6000000' }),
    ]);
    const tx = TransactionBuilder.fromXDR(built.body.unsigned_xdr, Networks.TESTNET);
    expect((tx.operations[0] as any).amount).toBe('0.6000000');
    tx.sign(merchantKey);
    await request(app.getHttpServer())
      .post(`/fees/settlements/${built.body.settlement_id}/submit`)
      .set('Cookie', cookie)
      .send({ signed_xdr: tx.toXDR() })
      .expect(201);

    const owed = await request(app.getHttpServer()).get('/fees/owed').set('Cookie', cookie).expect(200);
    expect(owed.body.totals).toEqual([
      expect.objectContaining({ asset_code: 'XLM', amount: '0.1500000', payments: 1 }),
    ]);
    const remaining = await pool.query(
      `SELECT fee_status, fee_owed_raw::text FROM payments
       WHERE paging_token = $1`,
      [`fee-partial-b-${stamp}`],
    );
    expect(remaining.rows[0]).toMatchObject({ fee_status: 'owed', fee_owed_raw: '0.1500000' });
  }, 60_000);

  it('lets the merchant dispute before signing and exposes the dispute to admins', async () => {
    await seedOwed(`fee-dispute-${stamp}`, '0.2000000');
    const built = await request(app.getHttpServer())
      .post('/fees/settlements')
      .set('Cookie', cookie)
      .send({ amount: '0.1000000', asset_code: 'XLM' })
      .expect(201);
    const tx = TransactionBuilder.fromXDR(built.body.unsigned_xdr, Networks.TESTNET);
    tx.sign(merchantKey);

    await request(app.getHttpServer())
      .post(`/fees/settlements/${built.body.settlement_id}/dispute`)
      .set('Cookie', cookie)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/fees/settlements/${built.body.settlement_id}/submit`)
      .set('Cookie', cookie)
      .send({ signed_xdr: tx.toXDR() })
      .expect(409);

    const owedRow = await pool.query(`SELECT fee_status, fee_owed_raw::text FROM payments WHERE paging_token = $1`, [`fee-dispute-${stamp}`]);
    expect(owedRow.rows[0]).toMatchObject({ fee_status: 'owed', fee_owed_raw: '0.2000000' });
    const owedAdmin = await request(app.getHttpServer()).get('/admin/fees/owed').set('Cookie', adminCookie).expect(200);
    expect(owedAdmin.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ merchant_id: merchantId, has_disputed_settlement: true })]),
    );
    const disputedAdmin = await request(app.getHttpServer()).get('/admin/fees/disputed').set('Cookie', adminCookie).expect(200);
    expect(disputedAdmin.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ settlement_id: built.body.settlement_id })]),
    );
  }, 60_000);

  it('alerts on a real Horizon rejection of an unsigned settlement', async () => {
    await seedOwed(`fee-rejected-${stamp}`, '0.1000000', otherMerchantId);
    const built = await request(app.getHttpServer()).post('/fees/settlements').set('Cookie', otherCookie).expect(201);
    await request(app.getHttpServer())
      .post(`/fees/settlements/${built.body.settlement_id}/submit`)
      .set('Cookie', otherCookie)
      .send({ signed_xdr: built.body.unsigned_xdr })
      .expect(400);

    const state = await pool.query('SELECT status, submission_error FROM fee_settlements WHERE id = $1', [built.body.settlement_id]);
    expect(state.rows[0].status).toBe('pending');
    expect(state.rows[0].submission_error).toBeTruthy();

    const watchdog = app.get(ReconcilerWatchdogService);
    const errors: string[] = [];
    const logger = (watchdog as unknown as { logger: { error: (message: string) => void } }).logger;
    const realError = logger.error;
    logger.error = (message: string) => void errors.push(message);
    try {
      const result = await watchdog.check();
      expect(result.failedFeeSettlements).toBeGreaterThan(0);
      expect(errors.some((message) => /fee settlement submission failures/.test(message))).toBe(true);
    } finally {
      logger.error = realError;
    }
  }, 60_000);

  it('refuses a transaction that is not the one Konfirm built', async () => {
    await seedOwed(`fee-c-${stamp}`, '0.1000000');
    const built = await request(app.getHttpServer()).post('/fees/settlements').set('Cookie', cookie).expect(201);

    // A different transaction from the same account, signed by the merchant.
    const acct = await fetch(`https://horizon-testnet.stellar.org/accounts/${merchantKey.publicKey()}`).then((r) => r.json());
    const swapped = new TransactionBuilder(new Account(merchantKey.publicKey(), acct.sequence), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
    })
      .addOperation(Operation.payment({ destination: merchantKey.publicKey(), asset: Asset.native(), amount: '0.0000001' }))
      .build();
    swapped.sign(merchantKey);

    await request(app.getHttpServer())
      .post(`/fees/settlements/${built.body.settlement_id}/submit`)
      .set('Cookie', cookie)
      .send({ signed_xdr: swapped.toXDR() })
      .expect(400);
  }, 60_000);

  it('will not let another merchant submit this merchant\'s settlement', async () => {
    const built = await request(app.getHttpServer()).post('/fees/settlements').set('Cookie', cookie).expect(201);
    const tx = TransactionBuilder.fromXDR(built.body.unsigned_xdr, Networks.TESTNET);
    tx.sign(otherKey);
    await request(app.getHttpServer())
      .post(`/fees/settlements/${built.body.settlement_id}/submit`)
      .set('Cookie', otherCookie)
      .send({ signed_xdr: tx.toXDR() })
      .expect(404);
  });

  it('releases the claims of a settlement that expired unsigned', async () => {
    const built = await request(app.getHttpServer()).post('/fees/settlements').set('Cookie', cookie).expect(201);
    await pool.query(`UPDATE fee_settlements SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [built.body.settlement_id]);
    // Its time bound has passed, so the chain has no record of it. Expiry is
    // safe to release.
    const fees = app.get(FeesService);
    await fees.sweepPending();
    const status = await pool.query('SELECT status FROM fee_settlements WHERE id = $1', [built.body.settlement_id]);
    expect(status.rows[0].status).toBe('expired');
    const back = await pool.query(`SELECT COUNT(*)::int AS n FROM payments WHERE merchant_id = $1 AND fee_status = 'owed'`, [merchantId]);
    expect(back.rows[0].n).toBeGreaterThan(0);
  }, 60_000);
});
