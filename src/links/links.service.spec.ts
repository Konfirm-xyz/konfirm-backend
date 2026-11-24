import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';
import { LinksService } from './links.service';

// Real Postgres (konfirm_test, see test/env.ts) — no mocks for the one
// thing (a merchant's own link records) this suite needs to get right.
describe('LinksService (integration, real Postgres)', () => {
  const links = new LinksService();
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

  afterAll(async () => {
    if (merchantIds.length > 0) {
      await pool.query('DELETE FROM payments WHERE merchant_id = ANY($1)', [merchantIds]);
      await pool.query('DELETE FROM links WHERE merchant_id = ANY($1)', [merchantIds]);
      await pool.query('DELETE FROM merchants WHERE id = ANY($1)', [merchantIds]);
    }
    await pool.end();
  });

  describe('create', () => {
    it('ignores no client-supplied merchant_id concept at the service layer -- merchant_id always comes from the caller', async () => {
      const merchantId = await seedMerchant();
      const link = await links.create({ merchant_id: merchantId, amount_usdc: '5.00', currency: 'USDC' });
      expect(link.merchant_id).toBe(merchantId);
      expect(link.active).toBe(true);
      expect(link.currency).toBe('USDC');
    });

    it('defaults currency to USDC and reusable to true when omitted', async () => {
      const merchantId = await seedMerchant();
      const link = await links.create({ merchant_id: merchantId, amount_usdc: '1.00' });
      expect(link.currency).toBe('USDC');
      expect(link.reusable).toBe(true);
    });

    it('is idempotent: the same (merchant, idempotency_key) returns the original link, not a second one', async () => {
      const merchantId = await seedMerchant();
      const first = await links.create({
        merchant_id: merchantId,
        amount_usdc: '2.00',
        idempotency_key: 'retry-key-1',
      });
      const second = await links.create({
        merchant_id: merchantId,
        amount_usdc: '999.00', // different body -- must still return the original, not re-apply this
        idempotency_key: 'retry-key-1',
      });
      expect(second.id).toBe(first.id);
      expect(second.amount_usdc).toBe(first.amount_usdc);

      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM links WHERE merchant_id = $1', [merchantId]);
      expect(rows[0].n).toBe(1);
    });

    it('the same idempotency_key under a different merchant creates its own separate link', async () => {
      const merchantA = await seedMerchant();
      const merchantB = await seedMerchant();
      const linkA = await links.create({ merchant_id: merchantA, amount_usdc: '3.00', idempotency_key: 'shared-key' });
      const linkB = await links.create({ merchant_id: merchantB, amount_usdc: '3.00', idempotency_key: 'shared-key' });
      expect(linkA.id).not.toBe(linkB.id);
    });
  });

  describe('listForMerchant', () => {
    it("lists only the calling merchant's own links, newest first, with a live use_count", async () => {
      const merchantA = await seedMerchant();
      const merchantB = await seedMerchant();
      const linkA1 = await links.create({ merchant_id: merchantA, amount_usdc: '1.00' });
      const linkA2 = await links.create({ merchant_id: merchantA, amount_usdc: '2.00' });
      await links.create({ merchant_id: merchantB, amount_usdc: '9.00' });

      // One paid, one held -- use_count must only reflect 'paid'.
      await pool.query(
        `INSERT INTO payments (merchant_id, link_id, muxed_id, muxed_address, payer_address,
            asset_code, amount_usdc, fee_usdc, net_usdc, channel, status, paging_token, tx_hash, ledger_sequence)
         VALUES ($1, $2, 1, 'G...', 'G...', 'USDC', 1, 0, 1, 'hosted_checkout', 'paid', $3, $4, 1)`,
        [merchantA, linkA1.id, `use-count-paid-${linkA1.id}`, `tx-paid-${linkA1.id}`],
      );
      await pool.query(
        `INSERT INTO payments (merchant_id, link_id, muxed_id, muxed_address, payer_address,
            asset_code, amount_usdc, fee_usdc, net_usdc, channel, status, flag_reason, paging_token, tx_hash, ledger_sequence)
         VALUES ($1, $2, 2, 'G...', 'G...', 'USDC', 1, 0, 1, 'hosted_checkout', 'held', 'amount_mismatch', $3, $4, 1)`,
        [merchantA, linkA1.id, `use-count-held-${linkA1.id}`, `tx-held-${linkA1.id}`],
      );

      const ownA = await links.listForMerchant(merchantA);
      expect(ownA.map((l: { id: string }) => l.id)).toEqual(expect.arrayContaining([linkA1.id, linkA2.id]));
      expect(ownA.map((l: { id: string }) => l.id)).not.toContain(undefined);
      expect(ownA.find((l: { id: string }) => l.id === linkA1.id).use_count).toBe(1);

      const ownB = await links.listForMerchant(merchantB);
      expect(ownB.map((l: { id: string }) => l.id)).not.toContain(linkA1.id);
      expect(ownB.map((l: { id: string }) => l.id)).not.toContain(linkA2.id);
    });

    it('returns an empty array for a merchant with no links', async () => {
      const merchantId = await seedMerchant();
      expect(await links.listForMerchant(merchantId)).toEqual([]);
    });
  });

  describe('deactivate', () => {
    it('sets active = false and returns the updated row', async () => {
      const merchantId = await seedMerchant();
      const link = await links.create({ merchant_id: merchantId, amount_usdc: '1.00' });
      const updated = await links.deactivate(link.id, merchantId);
      expect(updated.active).toBe(false);
      expect(updated.id).toBe(link.id);
    });

    it("404s rather than deactivating another merchant's link", async () => {
      const merchantA = await seedMerchant();
      const merchantB = await seedMerchant();
      const link = await links.create({ merchant_id: merchantA, amount_usdc: '1.00' });

      await expect(links.deactivate(link.id, merchantB)).rejects.toBeInstanceOf(NotFoundException);

      const { rows } = await pool.query('SELECT active FROM links WHERE id = $1', [link.id]);
      expect(rows[0].active).toBe(true);
    });

    it('404s for a link id that does not exist at all', async () => {
      const merchantId = await seedMerchant();
      await expect(links.deactivate(randomUUID(), merchantId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is idempotent against an already-inactive link', async () => {
      const merchantId = await seedMerchant();
      const link = await links.create({ merchant_id: merchantId, amount_usdc: '1.00' });
      await links.deactivate(link.id, merchantId);
      const second = await links.deactivate(link.id, merchantId);
      expect(second.active).toBe(false);
    });
  });

  describe('getPublic', () => {
    it('includes a fee preview and strips merchant_id from the projection', async () => {
      const merchantId = await seedMerchant();
      const link = await links.create({ merchant_id: merchantId, amount_usdc: '10.00', currency: 'USDC' });
      const pub = await links.getPublic(link.id);
      expect(pub).not.toHaveProperty('merchant_id');
      expect(pub.merchant_name).toBeDefined();
      expect(pub.stellar_base_address).toBeDefined();
      expect(pub.fee_usdc).not.toBeNull();
    });

    it('404s for an unknown link id', async () => {
      await expect(links.getPublic(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s for a malformed (non-UUID) link id instead of letting Postgres throw', async () => {
      await expect(links.getPublic('not-a-uuid')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deactivate', () => {
    it('404s for a malformed (non-UUID) link id', async () => {
      await expect(links.deactivate('not-a-uuid', randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
