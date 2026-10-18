import {
  FacilitatorHalted,
  FacilitatorSpendCapExceeded,
  FacilitatorSpendGuardService,
} from './facilitator-spend-guard.service';
import { pool } from '../db/pool';
import { concurrentCalls } from '../../test/helpers/concurrent';

// Real Postgres (konfirm_test, see test/env.ts), no mocks -- same
// convention as test/admin.e2e-spec.ts. This is plain SQL-backed logic, not
// HTTP, so it's exercised directly against the service rather than through
// a full Nest app + supertest.
describe('FacilitatorSpendGuardService', () => {
  const guard = new FacilitatorSpendGuardService();
  const originalCap = process.env.FACILITATOR_DAILY_SPEND_CAP_USDC;

  afterEach(async () => {
    await pool.query('DELETE FROM facilitator_spend_log');
    await pool.query('DELETE FROM facilitator_state');
    if (originalCap === undefined) delete process.env.FACILITATOR_DAILY_SPEND_CAP_USDC;
    else process.env.FACILITATOR_DAILY_SPEND_CAP_USDC = originalCap;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('defaults to a $0 cap when unconfigured -- unset fails closed, not open', async () => {
    delete process.env.FACILITATOR_DAILY_SPEND_CAP_USDC;
    await expect(guard.checkAndRecordSpend(1, 'sweep')).rejects.toThrow(FacilitatorSpendCapExceeded);
    const status = await guard.status();
    expect(status.halted).toBe(true);
  });

  it('fails closed on a non-numeric cap -- a config typo must never disable the cap', async () => {
    process.env.FACILITATOR_DAILY_SPEND_CAP_USDC = '5000usdc';
    await expect(guard.checkAndRecordSpend(1, 'sweep', 'typo-1')).rejects.toThrow(FacilitatorSpendCapExceeded);
    const status = await guard.status();
    expect(status.halted).toBe(true);
    expect(status.haltReason).toContain('cap misconfigured');
    expect(status.spentTodayUsdc).toBe(0);
    // Never NaN (which JSON-serializes to null and reads as "no cap"), and
    // the misconfiguration is reported alongside it.
    expect(status.capUsdc).toBe(0);
    expect(status.capConfigError).toContain('FACILITATOR_DAILY_SPEND_CAP_USDC');
  });

  it.each(['Infinity', '', '-100', '1e9', '0x10'])('treats cap value %j as misconfigured', async (raw) => {
    process.env.FACILITATOR_DAILY_SPEND_CAP_USDC = raw;
    await expect(guard.checkAndRecordSpend(0.01, 'sweep')).rejects.toThrow(FacilitatorSpendCapExceeded);
    expect((await guard.status()).capConfigError).not.toBeNull();
  });

  it('records spend under the cap and reflects it in status()', async () => {
    process.env.FACILITATOR_DAILY_SPEND_CAP_USDC = '100';
    await guard.checkAndRecordSpend(30, 'sweep', 'tx-1');
    const status = await guard.status();
    expect(status.halted).toBe(false);
    expect(status.spentTodayUsdc).toBe(30);
    expect(status.capUsdc).toBe(100);
    expect(status.capConfigError).toBeNull();
  });

  it('accumulates spend across calls against the same daily cap', async () => {
    process.env.FACILITATOR_DAILY_SPEND_CAP_USDC = '100';
    await guard.checkAndRecordSpend(40, 'sweep', 'tx-1');
    await guard.checkAndRecordSpend(40, 'sweep', 'tx-2');
    const status = await guard.status();
    expect(status.spentTodayUsdc).toBe(80);
    expect(status.halted).toBe(false);
  });

  it('serializes concurrent checks so they cannot jointly exceed the cap', async () => {
    process.env.FACILITATOR_DAILY_SPEND_CAP_USDC = '100';
    const results = await Promise.allSettled([
      guard.checkAndRecordSpend(60, 'sweep', 'race-a'),
      guard.checkAndRecordSpend(60, 'sweep', 'race-b'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const status = await guard.status();
    expect(status.spentTodayUsdc).toBe(60);
    expect(status.halted).toBe(true);
  });

  it('halts on a cap breach and rejects the over-cap operation', async () => {
    process.env.FACILITATOR_DAILY_SPEND_CAP_USDC = '100';
    await guard.checkAndRecordSpend(60, 'sweep', 'tx-1');
    await expect(guard.checkAndRecordSpend(60, 'sweep', 'tx-2')).rejects.toThrow(FacilitatorSpendCapExceeded);
    const status = await guard.status();
    expect(status.halted).toBe(true);
    expect(status.haltReason).toContain('daily cap exceeded');
    // The rejected attempt itself must never be recorded as spend.
    expect(status.spentTodayUsdc).toBe(60);
  });

  it('serializes concurrent calls so only spend within the cap is recorded', async () => {
    process.env.FACILITATOR_DAILY_SPEND_CAP_USDC = '100';
    const results = await concurrentCalls(2, (index) => guard.checkAndRecordSpend(60, 'sweep', `parallel-${index}`));
    const status = await guard.status();
    const logged = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM facilitator_spend_log');

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(status.halted).toBe(true);
    expect(status.spentTodayUsdc).toBe(60);
    expect(Number(logged.rows[0].count)).toBe(1);
  });

  it('stays halted for any further spend, even a small one, until resumed', async () => {
    process.env.FACILITATOR_DAILY_SPEND_CAP_USDC = '100';
    await guard.checkAndRecordSpend(100, 'sweep', 'tx-1');
    // This call is the one that breaches the cap (100 already spent + 0.01
    // > 100) -- it throws SpendCapExceeded and halts as a side effect.
    await expect(guard.checkAndRecordSpend(0.01, 'sweep', 'tx-2')).rejects.toThrow(FacilitatorSpendCapExceeded);
    // Any call after that sees the halt itself, regardless of amount.
    await expect(guard.checkAndRecordSpend(0.01, 'sweep', 'tx-3')).rejects.toThrow(FacilitatorHalted);
  });

  it('resume() clears the halt and lets spending continue against a fresh window', async () => {
    process.env.FACILITATOR_DAILY_SPEND_CAP_USDC = '100';
    await guard.checkAndRecordSpend(100, 'sweep', 'tx-1');
    await expect(guard.checkAndRecordSpend(1, 'sweep', 'tx-2')).rejects.toThrow(FacilitatorSpendCapExceeded);
    await expect(guard.checkAndRecordSpend(1, 'sweep', 'tx-3')).rejects.toThrow(FacilitatorHalted);

    const cleared = await guard.resume();
    // The halt details must come back so the admin audit log can keep them.
    expect(cleared.haltReason).toContain('daily cap exceeded');
    expect(cleared.haltedAt).not.toBeNull();
    expect(cleared.capUsdc).toBe(100);
    expect(cleared.spentTodayUsdc).toBe(100);
    const status = await guard.status();
    expect(status.halted).toBe(false);

    // Resume clears the halt flag, not the day's recorded spend -- the cap
    // is still $100 already spent, so anything over 0 remaining is still a
    // breach. This is intentional: resuming after a breach doesn't grant a
    // fresh $100 of headroom for the rest of the day.
    await expect(guard.checkAndRecordSpend(1, 'sweep', 'tx-3')).rejects.toThrow(FacilitatorSpendCapExceeded);
  });

  it('runs every pooled session in UTC, so the daily window is UTC midnight', async () => {
    const { rows } = await pool.query<{ timezone: string }>('SHOW timezone');
    expect(rows[0].timezone).toBe('UTC');
  });

  it("keeps the spend window pinned to UTC even when a session's timezone drifts", async () => {
    process.env.FACILITATOR_DAILY_SPEND_CAP_USDC = '100';
    await guard.checkAndRecordSpend(10, 'sweep', 'tx-1');
    const client = await pool.connect();
    try {
      await client.query("SET timezone TO 'Pacific/Kiritimati'");
      // A fresh pooled connection must still start in UTC.
      const { rows } = await pool.query<{ timezone: string }>('SHOW timezone');
      expect(rows[0].timezone).toBe('UTC');
      const { rows: boundary } = await pool.query<{ utc_midnight: boolean }>(
        "SELECT date_trunc('day', NOW()) = (date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS utc_midnight",
      );
      expect(boundary[0].utc_midnight).toBe(true);
    } finally {
      await client.query("SET timezone TO 'UTC'");
      client.release();
    }
    expect((await guard.status()).spentTodayUsdc).toBe(10);
  });
});
