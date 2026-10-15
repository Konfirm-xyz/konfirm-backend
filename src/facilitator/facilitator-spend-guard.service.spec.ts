import {
  FacilitatorHalted,
  FacilitatorSpendCapExceeded,
  FacilitatorSpendGuardService,
  parseDailyCapUsdc,
} from './facilitator-spend-guard.service';
import { pool } from '../db/pool';

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
    expect(status.capUsdc).toBe(0);
    expect(status.capConfigError).toBeNull();
  });

  it('fails closed and surfaces capConfigError when FACILITATOR_DAILY_SPEND_CAP_USDC is non-numeric (#81)', async () => {
    process.env.FACILITATOR_DAILY_SPEND_CAP_USDC = '5000usdc';
    expect(parseDailyCapUsdc('5000usdc')).toEqual({
      capUsdc: 0,
      configError: expect.stringContaining('not a valid non-negative number'),
    });

    await expect(guard.checkAndRecordSpend(1, 'sweep', 'tx-invalid-cap')).rejects.toThrow(
      FacilitatorSpendCapExceeded,
    );
    const status = await guard.status();
    expect(status.halted).toBe(true);
    expect(Number.isFinite(status.capUsdc)).toBe(true);
    expect(status.capUsdc).toBe(0);
    expect(status.capConfigError).toContain('not a valid non-negative number');
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

    await guard.resume();
    const status = await guard.status();
    expect(status.halted).toBe(false);

    // Resume clears the halt flag, not the day's recorded spend -- the cap
    // is still $100 already spent, so anything over 0 remaining is still a
    // breach. This is intentional: resuming after a breach doesn't grant a
    // fresh $100 of headroom for the rest of the day.
    await expect(guard.checkAndRecordSpend(1, 'sweep', 'tx-3')).rejects.toThrow(FacilitatorSpendCapExceeded);
  });
});
