import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool';
import { AdminNotificationsService } from './admin-notifications.service';

// Real Postgres (konfirm_test, see test/env.ts). staleAttestations() used to
// query a table that never existed, so GET /admin/notifications 500'd on every
// call and no test noticed. This suite calls the method directly.
describe('AdminNotificationsService (integration, real Postgres)', () => {
  const notifications = new AdminNotificationsService();
  const merchantIds: string[] = [];

  async function seedMerchant(): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO merchants (id, email, password_hash, name, stellar_base_address)
       VALUES ($1, $2, 'test', 'test', 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB')`,
      [id, `${id}@example.test`],
    );
    merchantIds.push(id);
    return id;
  }

  async function seedPayment(
    merchantId: string,
    opts: { status: string; attested: boolean; ageHours: number; muxedId: number },
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO payments (merchant_id, muxed_id, muxed_address, payer_address,
          asset_code, amount_usdc, fee_usdc, net_usdc, channel, status, attested_at,
          paging_token, tx_hash, ledger_sequence, created_at)
       VALUES ($1, $2, 'G...', 'G...', 'USDC', 1, 0, 1, 'hosted_checkout', $3,
          CASE WHEN $4 THEN NOW() ELSE NULL END, $5, $6, 1, NOW() - ($7 || ' hours')::interval)
       RETURNING id`,
      [
        merchantId,
        opts.muxedId,
        opts.status,
        opts.attested,
        `stale-attestation-${randomUUID()}`,
        `tx-${randomUUID()}`,
        String(opts.ageHours),
      ],
    );
    return rows[0].id;
  }

  afterAll(async () => {
    if (merchantIds.length > 0) {
      await pool.query('DELETE FROM payments WHERE merchant_id = ANY($1)', [merchantIds]);
      await pool.query('DELETE FROM merchants WHERE id = ANY($1)', [merchantIds]);
    }
    await pool.end();
  });

  describe('staleAttestations', () => {
    it('flags only paid, unattested payments older than 24 hours', async () => {
      const merchantId = await seedMerchant();
      const overdue = await seedPayment(merchantId, { status: 'paid', attested: false, ageHours: 48, muxedId: 1 });
      const fresh = await seedPayment(merchantId, { status: 'paid', attested: false, ageHours: 1, muxedId: 2 });
      const attested = await seedPayment(merchantId, { status: 'paid', attested: true, ageHours: 48, muxedId: 3 });
      const held = await seedPayment(merchantId, { status: 'held', attested: false, ageHours: 48, muxedId: 4 });

      const rows = await (notifications as unknown as {
        staleAttestations(): Promise<Array<{ id: string; type: string; severity: string; link: string; detail: string }>>;
      }).staleAttestations();

      const ids = rows.map((r) => r.id);
      expect(ids).toContain(`stale-attestation-${overdue}`);
      expect(ids).not.toContain(`stale-attestation-${fresh}`);
      expect(ids).not.toContain(`stale-attestation-${attested}`);
      expect(ids).not.toContain(`stale-attestation-${held}`);

      const row = rows.find((r) => r.id === `stale-attestation-${overdue}`)!;
      expect(row.type).toBe('stale_attestation');
      expect(row.severity).toBe('warning');
      expect(row.link).toBe('/admin/payments');
      expect(row.detail).toContain(overdue);
    });

    it('returns an empty array when nothing is overdue', async () => {
      const merchantId = await seedMerchant();
      await seedPayment(merchantId, { status: 'paid', attested: true, ageHours: 48, muxedId: 1 });

      const rows = await (notifications as unknown as {
        staleAttestations(): Promise<unknown[]>;
      }).staleAttestations();
      expect(Array.isArray(rows)).toBe(true);
    });
  });
});
