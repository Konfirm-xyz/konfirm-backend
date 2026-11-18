import { AdminActionsService, AdminActivityFilter } from '../admin-actions.service';
import { AdminController } from '../admin.controller';
import { pool } from '../../db/pool';

jest.mock('../../db/pool', () => ({
  pool: {
    query: jest.fn(),
  },
}));

describe('AdminActionsService.recent filtering', () => {
  let service: AdminActionsService;
  const mockQuery = pool.query as jest.Mock;

  beforeEach(() => {
    service = new AdminActionsService();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('defaults to limit 20 and no WHERE clause when called without filter', async () => {
    await service.recent();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('WHERE');
    expect(sql).toContain('LIMIT $1');
    expect(values).toEqual([20]);
  });

  it('supports legacy numeric limit parameter', async () => {
    await service.recent(50);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('WHERE');
    expect(sql).toContain('LIMIT $1');
    expect(values).toEqual([50]);
  });

  it('filters by admin_id', async () => {
    await service.recent({ admin_id: 'admin-123' });
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE aa.admin_id = $1');
    expect(sql).toContain('LIMIT $2');
    expect(values).toEqual(['admin-123', 20]);
  });

  it('filters by action', async () => {
    await service.recent({ action: 'facilitator.pause' });
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE aa.action = $1');
    expect(values).toEqual(['facilitator.pause', 20]);
  });

  it('filters by target_type and target_id', async () => {
    await service.recent({ target_type: 'merchant', target_id: 'merch-456' });
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE aa.target_type = $1 AND aa.target_id = $2');
    expect(values).toEqual(['merchant', 'merch-456', 20]);
  });

  it('filters by date range (from and to)', async () => {
    const from = '2026-11-01T00:00:00Z';
    const to = '2026-11-18T23:59:59Z';
    await service.recent({ from, to });
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE aa.created_at >= $1 AND aa.created_at <= $2');
    expect(values).toEqual([from, to, 20]);
  });

  it('supports pagination with offset and custom limit', async () => {
    await service.recent({ limit: 15, offset: 30 });
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('LIMIT $1 OFFSET $2');
    expect(values).toEqual([15, 30]);
  });

  it('combines multiple filter parameters cleanly with parameterized queries', async () => {
    const filter: AdminActivityFilter = {
      admin_id: 'admin-999',
      action: 'merchant.update',
      target_type: 'merchant',
      target_id: 'm-1',
      from: '2026-11-10T00:00:00Z',
      to: '2026-11-15T00:00:00Z',
      limit: 10,
      offset: 5,
    };
    await service.recent(filter);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE aa.admin_id = $1 AND aa.action = $2 AND aa.target_type = $3 AND aa.target_id = $4 AND aa.created_at >= $5 AND aa.created_at <= $6');
    expect(sql).toContain('LIMIT $7 OFFSET $8');
    expect(values).toEqual([
      'admin-999',
      'merchant.update',
      'merchant',
      'm-1',
      '2026-11-10T00:00:00Z',
      '2026-11-15T00:00:00Z',
      10,
      5,
    ]);
  });
});

describe('AdminController.recentActivity handler', () => {
  it('forwards query params to AdminActionsService.recent', async () => {
    const mockService = {
      recent: jest.fn().mockResolvedValue([{ id: 'action-1' }]),
    } as unknown as AdminActionsService;

    const controller = Object.create(AdminController.prototype);
    (controller as any).actions = mockService;

    const res = await controller.recentActivity(
      '25',
      '50',
      'admin-uuid',
      'facilitator.resume',
      'facilitator',
      'guard',
      '2026-11-01',
      '2026-11-18',
    );

    expect(mockService.recent).toHaveBeenCalledWith({
      limit: 25,
      offset: 50,
      admin_id: 'admin-uuid',
      action: 'facilitator.resume',
      target_type: 'facilitator',
      target_id: 'guard',
      from: '2026-11-01',
      to: '2026-11-18',
    });
    expect(res).toEqual([{ id: 'action-1' }]);
  });
});
