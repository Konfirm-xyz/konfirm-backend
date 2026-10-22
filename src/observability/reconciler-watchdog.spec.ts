import { pool } from '../db/pool';
import { FacilitatorSpendGuardService } from '../facilitator/facilitator-spend-guard.service';
import { ReconcilerWatchdogService } from './reconciler-watchdog.service';

describe('ReconcilerWatchdogService', () => {
  const svc = new ReconcilerWatchdogService();
  const errors: string[] = [];
  const realError = (svc as unknown as { logger: { error: (m: string) => void } }).logger.error;
  const fixtureEmail = `watchdog-${Date.now()}@example.com`;
  const originalCap = process.env.FACILITATOR_DAILY_SPEND_CAP_USDC;
  const spendGuard = new FacilitatorSpendGuardService();
  let fixtureMerchantId: string;
  let fixtureSettlementId: string;

  beforeEach(() => {
    errors.length = 0;
    (svc as unknown as { logger: { error: (m: string) => void } }).logger.error = (m: string) => void errors.push(m);
  });
  afterEach(async () => {
    (svc as unknown as { logger: { error: (m: string) => void } }).logger.error = realError;
    await pool.query('DELETE FROM fee_settlements WHERE id = $1', [fixtureSettlementId ?? null]);
    await pool.query('DELETE FROM merchants WHERE id = $1', [fixtureMerchantId ?? null]);
    await pool.query("DELETE FROM facilitator_state WHERE key IN ('halted_at', 'halt_reason')");
    if (originalCap === undefined) delete process.env.FACILITATOR_DAILY_SPEND_CAP_USDC;
    else process.env.FACILITATOR_DAILY_SPEND_CAP_USDC = originalCap;
    await pool.query("UPDATE reconciler_state SET updated_at = NOW()");
  });
  afterAll(async () => {
    await pool.end();
  });

  it('reports a fresh cursor as healthy', async () => {
    await pool.query("UPDATE reconciler_state SET updated_at = NOW()");
    const r = await svc.check();
    expect(r.stalled).toBe(false);
    expect(errors).toEqual([]);
  });

  it('flags a cursor that has not moved, while merchants are active', async () => {
    await pool.query("UPDATE reconciler_state SET updated_at = NOW() - INTERVAL '30 minutes'");
    const r = await svc.check();
    const active = (await pool.query("SELECT COUNT(*)::int AS n FROM merchants WHERE status = 'active' AND stellar_base_address IS NOT NULL")).rows[0].n;
    if (active > 0) {
      expect(r.stalled).toBe(true);
      expect(errors.length).toBe(1);
      expect(errors[0]).toMatch(/stalled/);
    } else {
      expect(r.stalled).toBe(false);
    }
  });

  it('logs a failed query through its own logger instead of throwing', async () => {
    const spy = jest.spyOn(pool, 'query').mockRejectedValueOnce(new Error('connection terminated') as never);
    try {
      const r = await svc.check();
      expect(r).toEqual({ stalled: false, ageMinutes: null });
      expect(errors.length).toBe(1);
      expect(errors[0]).toMatch(/watchdog check failed: connection terminated/);
    } finally {
      spy.mockRestore();
    }
  });
});
