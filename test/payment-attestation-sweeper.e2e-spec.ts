import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { pool } from '../src/db/pool';
import { PaymentAttestationSweeperService } from '../src/payments/payment-attestation-sweeper.service';
import { PaymentAttestationService } from '../src/payments/payment-attestation.service';

// Integration tests for PaymentAttestationSweeperService.
//
// These boot the full Nest application (real Postgres, real NestJS DI, real
// ScheduleModule) but swap out the one external dependency — the Soroban
// contract call inside PaymentAttestationService.attest() — with a jest mock
// override. That lets us verify all of the sweeper's own logic:
//
//   - finds payments WHERE status='paid' AND attested_at IS NULL
//   - writes back onchain_payment_id + attested_at on success
//   - skips rows with a NULL merchant_address without aborting the rest
//   - leaves rows untouched when attest() returns {success:false}
//   - per-row errors don't abort the batch (remaining rows still process)
//   - the pg_try_advisory_lock guard prevents double-sweeping
//
// All of these are real behaviors on real Postgres rows; none are mocked.
// Only the Soroban RPC call is, because the 'fast' suite never hits testnet.
// If you want to test the real contract submission end-to-end, that belongs
// in the 'live' suite alongside fees.e2e-spec.ts.
//
// Isolation: each test cleans up its own seeded rows in an afterEach so that
// leftover unattested rows from one test can't be picked up by the next
// test's sweep() call, which would invalidate not.toHaveBeenCalled() assertions.

describe('PaymentAttestationSweeperService (integration, real Postgres)', () => {
  let app: INestApplication;
  let sweeper: PaymentAttestationSweeperService;
  let attestMock: jest.Mock;

  const stamp = Date.now();
  const merchantEmail = `attestation-sweeper-${stamp}@example.com`;
  const merchantAddress = 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB';
  let merchantId: string;

  // Track every payment id seeded by the current test so afterEach can clean up.
  const seededIds: string[] = [];

  // Insert a minimal payment row. Returns the new row's id.
  async function seedPayment(
    pagingToken: string,
    overrides: {
      status?: string;
      alreadyAttested?: boolean;
      merchantId?: string;
    } = {},
  ): Promise<string> {
    const { status = 'paid', alreadyAttested = false, merchantId: mid = merchantId } = overrides;
    const muxedId = Math.floor(Math.random() * 1e12);

    const result = await pool.query<{ id: string }>(
      `INSERT INTO payments
         (merchant_id, muxed_id, muxed_address, payer_address, asset_code,
          amount_usdc, fee_usdc, net_usdc, channel, status, paging_token,
          tx_hash, ledger_sequence, attested_at)
       VALUES
         ($1, $2, $3, $4, 'USDC',
          5.0000000, 0, 5.0000000, 'hosted_checkout', $5, $6,
          'aaaa' || $6, 1, CASE WHEN $7 THEN NOW() ELSE NULL END)
       RETURNING id`,
      [mid, muxedId, merchantAddress, 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
       status, pagingToken, alreadyAttested],
    );

    const id = result.rows[0].id;
    seededIds.push(id);
    return id;
  }

  beforeAll(async () => {
    // Boot a real Nest application against konfirm_test.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    // Retrieve the service instances already in the DI container so we share
    // the same pool, pg_advisory_lock logic, etc. as the live sweeper.
    sweeper = app.get(PaymentAttestationSweeperService);
    const attestation = app.get(PaymentAttestationService);

    // Swap the real attest() with a jest mock. The default return is a success
    // with a stable fake onchain_payment_id; individual tests may override it.
    attestMock = jest.spyOn(attestation, 'attest').mockResolvedValue({
      success: true,
      onchainPaymentId: '42',
      transaction: 'fakehash',
    }) as jest.Mock;

    // Seed a merchant with a known stellar_base_address.
    const res = await pool.query<{ id: string }>(
      `INSERT INTO merchants (email, password_hash, name, stellar_base_address, status)
       VALUES ($1, 'x', 'Attestation Test', $2, 'active')
       RETURNING id`,
      [merchantEmail, merchantAddress],
    );
    merchantId = res.rows[0].id;
  }, 30_000);

  afterEach(async () => {
    // Remove every row seeded by this test before moving on. This is the
    // key isolation guarantee: a leftover unattested 'paid' row from a prior
    // test would otherwise be swept up by the next test's sweep() call,
    // breaking not.toHaveBeenCalled() assertions.
    if (seededIds.length > 0) {
      await pool.query('DELETE FROM payments WHERE id = ANY($1)', [seededIds]);
      seededIds.length = 0;
    }

    attestMock.mockReset();
    attestMock.mockResolvedValue({
      success: true,
      onchainPaymentId: '42',
      transaction: 'fakehash',
    });
  });

  afterAll(async () => {
    // Belt-and-suspenders cleanup for anything seededIds might have missed
    // (e.g. rows seeded in a nested try/finally block under a different merchant).
    await pool.query(`DELETE FROM payments WHERE merchant_id = $1`, [merchantId]);
    await pool.query('DELETE FROM merchants WHERE email = $1', [merchantEmail]);
    await app.close();
    await pool.end();
  }, 30_000);

  it('writes onchain_payment_id and attested_at back to a due payment on success', async () => {
    const id = await seedPayment(`sweep-success-${stamp}`);

    await sweeper.sweep();

    const row = await pool.query<{ onchain_payment_id: string; attested_at: Date | null }>(
      'SELECT onchain_payment_id, attested_at FROM payments WHERE id = $1',
      [id],
    );
    expect(row.rows[0].onchain_payment_id).toBe('42');
    expect(row.rows[0].attested_at).not.toBeNull();
  });

  it('calls attest() with the correct fields from the payment and merchant rows', async () => {
    await seedPayment(`sweep-args-${stamp}`);

    await sweeper.sweep();

    expect(attestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantAddress,
        payerAddress: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
        netUsdc: '5.0000000',
      }),
    );
  });

  it('skips already-attested payments — attested_at IS NOT NULL rows are not re-submitted', async () => {
    await seedPayment(`sweep-already-attested-${stamp}`, { alreadyAttested: true });

    await sweeper.sweep();

    // No unattested row in this batch, so attest() must not be called at all.
    expect(attestMock).not.toHaveBeenCalled();
  });

  it('skips held payments — only status=paid rows are candidates', async () => {
    await seedPayment(`sweep-held-${stamp}`, { status: 'held' });

    await sweeper.sweep();

    expect(attestMock).not.toHaveBeenCalled();
  });

  it('leaves the row unmodified when attest() returns {success:false}', async () => {
    attestMock.mockResolvedValue({ success: false, errorReason: 'contract_error_whatever' });

    const id = await seedPayment(`sweep-failure-${stamp}`);

    await sweeper.sweep();

    const row = await pool.query<{ onchain_payment_id: string | null; attested_at: Date | null }>(
      'SELECT onchain_payment_id, attested_at FROM payments WHERE id = $1',
      [id],
    );
    expect(row.rows[0].onchain_payment_id).toBeNull();
    expect(row.rows[0].attested_at).toBeNull();
  });

  it('continues processing remaining rows after a per-row attest() exception', async () => {
    const idFail = await seedPayment(`sweep-error-first-${stamp}`);
    const idOk = await seedPayment(`sweep-error-second-${stamp}`);

    // First call throws, second succeeds.
    attestMock
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce({ success: true, onchainPaymentId: '99', transaction: 'ok' });

    await sweeper.sweep();

    // The erroring row stays unattested.
    const failRow = await pool.query<{ attested_at: Date | null }>(
      'SELECT attested_at FROM payments WHERE id = $1',
      [idFail],
    );
    expect(failRow.rows[0].attested_at).toBeNull();

    // The succeeding row is written back correctly.
    const okRow = await pool.query<{ onchain_payment_id: string; attested_at: Date | null }>(
      'SELECT onchain_payment_id, attested_at FROM payments WHERE id = $1',
      [idOk],
    );
    expect(okRow.rows[0].onchain_payment_id).toBe('99');
    expect(okRow.rows[0].attested_at).not.toBeNull();
  });

  it('does not attest a row whose merchant stellar_base_address is NULL — warns and skips', async () => {
    // Insert a merchant with no stellar_base_address so the sweeper's NULL
    // check is exercised.
    const res = await pool.query<{ id: string }>(
      `INSERT INTO merchants (email, password_hash, name, status)
       VALUES ($1, 'x', 'No Address', 'active')
       RETURNING id`,
      [`attestation-noaddr-${stamp}@example.com`],
    );
    const noAddrMerchantId = res.rows[0].id;

    let paymentId: string | undefined;
    try {
      paymentId = await seedPayment(`sweep-no-addr-${stamp}`, { merchantId: noAddrMerchantId });

      await sweeper.sweep();

      // attest() must never be called with a null merchant address.
      expect(attestMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ merchantAddress: null }),
      );

      // Row stays unattested.
      const row = await pool.query<{ attested_at: Date | null }>(
        'SELECT attested_at FROM payments WHERE id = $1',
        [paymentId],
      );
      expect(row.rows[0].attested_at).toBeNull();
    } finally {
      // Clean up under the no-address merchant directly; afterEach will also
      // attempt a delete for the same id via seededIds, but a delete on an
      // already-gone row is a harmless no-op.
      await pool.query('DELETE FROM payments WHERE merchant_id = $1', [noAddrMerchantId]);
      await pool.query('DELETE FROM merchants WHERE id = $1', [noAddrMerchantId]);
    }
  });

  it('second concurrent sweep() call returns immediately when the advisory lock is already held', async () => {
    // Hold the advisory lock from outside the sweeper so the second sweep()
    // call sees it as taken and returns without doing any work.
    const lockClient = await pool.connect();
    try {
      // 402004, not 402003: ATTESTATION_LOCK_KEY moved to 402004 when
      // FeeCollectionSweepService claimed 402003 (see payment-attestation-
      // sweeper.service.ts) — this literal just never got updated to match.
      await lockClient.query('SELECT pg_advisory_lock(402004)');

      await seedPayment(`sweep-lock-guard-${stamp}`);
      await sweeper.sweep();

      // The lock was taken; no attest() should have been called.
      expect(attestMock).not.toHaveBeenCalled();
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(402004)');
      lockClient.release();
    }
  });
});
