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

  it('queries x402_settlements for failed settlements using valid schema columns', async () => {
    const mockRow = {
      id: 'd19642e0-2529-45b9-91fb-b924376c2211',
      payer_address: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
      amount: '25.00',
      created_at: '2026-11-19T10:00:00.000Z',
    };

    const querySpy = jest.spyOn(pool, 'query').mockImplementation(async (sql: string) => {
      if (sql.includes('x402_settlements')) {
        expect(sql).not.toContain('error');
        expect(sql).toContain('payer_address');
        expect(sql).toContain('amount');
        return { rows: [mockRow] } as any;
      }
      return { rows: [] } as any;
    });

    const notifications = await service.list();
    expect(querySpy).toHaveBeenCalled();

    const failureNotification = notifications.find(
      (n) => n.id === `x402-settlement-failure-${mockRow.id}`,
    );
    expect(failureNotification).toBeDefined();
    expect(failureNotification?.severity).toBe('critical');
    expect(failureNotification?.type).toBe('x402_settlement_failure');
    expect(failureNotification?.detail).toContain(mockRow.payer_address.slice(0, 8));
    expect(failureNotification?.detail).toContain('25.00 USDC');
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


  it('handles empty query results without error', async () => {
    jest.spyOn(pool, 'query').mockImplementation(async () => ({ rows: [] } as any));
    const notifications = await service.list();
    expect(notifications).toEqual([]);
  });
});
