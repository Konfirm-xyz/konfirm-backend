import { pool } from '../db/pool';
import { AdminLinksService } from './admin-links.service';

// Real Postgres (konfirm_test, see test/env.ts), no mocks — same convention
// as test/admin.e2e-spec.ts and facilitator-spend-guard.service.spec.ts.
describe('AdminLinksService (integration, real Postgres)', () => {
  const service = new AdminLinksService();
  const merchantEmail = `admin-links-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  let merchantId: string;

  beforeAll(async () => {
    const { rows } = await pool.query(
      `INSERT INTO merchants (email, password_hash, name, status)
       VALUES ($1, 'not-a-real-hash', 'Links Test Merchant', 'active')
       RETURNING id`,
      [merchantEmail],
    );
    merchantId = rows[0].id;
  });

  afterEach(async () => {
    await pool.query('DELETE FROM payments WHERE merchant_id = $1', [merchantId]);
    await pool.query('DELETE FROM links WHERE merchant_id = $1', [merchantId]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM merchants WHERE id = $1', [merchantId]);
    await pool.end();
  });

  it('reports use_count = 0 and net_usdc = "0" for a link whose payments are held, disputed, or refunded', async () => {
    const { rows: linkRows } = await pool.query(
      `INSERT INTO links (merchant_id, amount_usdc, currency, description)
       VALUES ($1, 100, 'USDC', 'non-paid link')
       RETURNING id`,
      [merchantId],
    );
    const linkId: string = linkRows[0].id;

    await pool.query(
      `INSERT INTO payments (merchant_id, link_id, muxed_id, muxed_address, payer_address, asset_code, amount_usdc, fee_usdc, net_usdc, status, paging_token, tx_hash, ledger_sequence)
       VALUES
         ($1, $2, 1001, 'M...links1', 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL', 'USDC', 100, 1, 99, 'refunded', $3, 'tx-links-1', 1),
         ($1, $2, 1002, 'M...links2', 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL', 'USDC', 50, 0.5, 49.5, 'held', $4, 'tx-links-2', 1),
         ($1, $2, 1003, 'M...links3', 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL', 'USDC', 25, 0.25, 24.75, 'disputed', $5, 'tx-links-3', 1)`,
      [
        merchantId,
        linkId,
        `links-paging-1-${Date.now()}`,
        `links-paging-2-${Date.now()}`,
        `links-paging-3-${Date.now()}`,
      ],
    );

    const rows = await service.list(50, 0);
    const row = rows.find((l: { id: string }) => l.id === linkId);
    expect(row).toBeDefined();
    expect(row.use_count).toBe(0);
    expect(row.net_usdc).toBe('0');
  });

  it('counts only status = "paid" rows in use_count and net_usdc when mixed with refunded/held/disputed rows', async () => {
    const { rows: linkRows } = await pool.query(
      `INSERT INTO links (merchant_id, amount_usdc, currency, description)
       VALUES ($1, 10, 'USDC', 'mixed-status link')
       RETURNING id`,
      [merchantId],
    );
    const linkId: string = linkRows[0].id;

    await pool.query(
      `INSERT INTO payments (merchant_id, link_id, muxed_id, muxed_address, payer_address, asset_code, amount_usdc, fee_usdc, net_usdc, status, paging_token, tx_hash, ledger_sequence)
       VALUES
         ($1, $2, 2001, 'M...mix1', 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL', 'USDC', 10, 1, 9, 'paid', $3, 'tx-mix-1', 1),
         ($1, $2, 2002, 'M...mix2', 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL', 'USDC', 20, 2, 18, 'refunded', $4, 'tx-mix-2', 1),
         ($1, $2, 2003, 'M...mix3', 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL', 'USDC', 15, 1.5, 13.5, 'paid', $5, 'tx-mix-3', 1),
         ($1, $2, 2004, 'M...mix4', 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL', 'USDC', 30, 3, 27, 'held', $6, 'tx-mix-4', 1)`,
      [
        merchantId,
        linkId,
        `mix-paging-1-${Date.now()}`,
        `mix-paging-2-${Date.now()}`,
        `mix-paging-3-${Date.now()}`,
        `mix-paging-4-${Date.now()}`,
      ],
    );

    const rows = await service.list(50, 0);
    const row = rows.find((l: { id: string }) => l.id === linkId);
    expect(row).toBeDefined();
    expect(row.use_count).toBe(2);
    expect(Number(row.net_usdc)).toBeCloseTo(22.5, 5);
  });
});
