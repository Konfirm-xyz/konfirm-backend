import { AdminNotificationsService } from './admin-notifications.service';
import { pool } from '../db/pool';

describe('AdminNotificationsService', () => {
  let service: AdminNotificationsService;

  beforeEach(() => {
    service = new AdminNotificationsService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('queries payments for overdue un-attested payments instead of non-existent attestations table', async () => {
    const mockPayment = {
      id: 'pay_9941a02e_5e1b_4335_8d8b_127f8d6f51c2',
      created_at: '2026-11-18T10:00:00.000Z',
    };

    const querySpy = jest.spyOn(pool, 'query').mockImplementation(async (sql: string) => {
      // Must not query the non-existent 'attestations' table
      expect(sql).not.toMatch(/FROM\s+attestations/i);

      if (sql.includes('attested_at IS NULL')) {
        expect(sql).toContain('payments');
        expect(sql).toContain("status = 'paid'");
        return { rows: [mockPayment] } as any;
      }
      return { rows: [] } as any;
    });

    const notifications = await service.list();
    expect(querySpy).toHaveBeenCalled();

    const staleNotification = notifications.find(
      (n) => n.id === `stale-attestation-${mockPayment.id}`,
    );
    expect(staleNotification).toBeDefined();
    expect(staleNotification?.type).toBe('stale_attestation');
    expect(staleNotification?.severity).toBe('warning');
    expect(staleNotification?.link).toBe('/admin/payments');
    expect(staleNotification?.detail).toContain(mockPayment.id);
  });

  it('handles empty query results across all notification signals without error', async () => {
    jest.spyOn(pool, 'query').mockImplementation(async () => ({ rows: [] } as any));
    const notifications = await service.list();
    expect(notifications).toEqual([]);
  });
});
