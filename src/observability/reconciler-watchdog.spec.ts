import * as sentry from './sentry';
import { pool } from '../db/pool';
import { ReconcilerWatchdogService } from './reconciler-watchdog.service';

describe('ReconcilerWatchdogService', () => {
  const svc = new ReconcilerWatchdogService();
  const errors: string[] = [];
  const realError = (svc as unknown as { logger: { error: (m: string) => void } }).logger.error;

  beforeEach(() => {
    errors.length = 0;
    (svc as unknown as { logger: { error: (m: string) => void } }).logger.error = (m: string) => void errors.push(m);
  });
  afterEach(async () => {
    (svc as unknown as { logger: { error: (m: string) => void } }).logger.error = realError;
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

  it('catches and logs query failures through the logger rather than throwing', async () => {
    const captureSpy = jest.spyOn(sentry, 'captureException').mockImplementation(() => {});
    const querySpy = jest
      .spyOn(pool, 'query')
      .mockImplementationOnce(() => Promise.reject(new Error('simulated db outage')));
    const r = await svc.check();
    expect(r.stalled).toBe(false);
    expect(r.ageMinutes).toBeNull();
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/watchdog check failed: simulated db outage/);
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledWith(expect.objectContaining({ message: 'simulated db outage' }));
    querySpy.mockRestore();
    captureSpy.mockRestore();
  });
});
