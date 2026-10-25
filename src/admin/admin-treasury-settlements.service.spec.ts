import { pool } from '../db/pool';
import { AdminTreasurySettlementsService } from './admin-treasury-settlements.service';

// Real testnet RPC, real redeployed treasury contract -- part of the
// 'live' suite (see jest.config.js), not 'fast'. Settlement id 1 is a real
// settlement created on testnet while verifying PRD docs/PRD.md M2's
// evidence gate (see docs/VERIFY.md in the workspace root): propose_settlement
// (deployer) then approve_settlement (signer2) reached the 2-of-3
// threshold; execute_settlement then correctly trapped on the treasury's
// 0 USDC balance, leaving it Pending. This test proves
// AdminTreasurySettlementsService reads that real state correctly, not a
// mock of it.
describe('AdminTreasurySettlementsService (live testnet)', () => {
  const service = new AdminTreasurySettlementsService();
  const realSettlementId = 1n;

  afterEach(async () => {
    await pool.query('DELETE FROM treasury_settlements WHERE onchain_settlement_id = $1', [realSettlementId.toString()]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('reads the real on-chain settlement and mirrors it', async () => {
    const row = await service.registerOrResync(realSettlementId);

    expect(row.onchain_settlement_id).toBe('1');
    expect(row.amount).toBe('1000000');
    expect(row.approvals_count).toBe(2);
    expect(row.status).toBe('Pending');
    expect(row.merchant_address).toMatch(/^G[A-Z0-9]{55}$/);
  });

  it('lists and gets what it already synced', async () => {
    await service.registerOrResync(realSettlementId);

    const fetched = await service.get(realSettlementId);
    expect(fetched?.status).toBe('Pending');

    const listed = await service.list();
    expect(listed.some((row) => row.onchain_settlement_id === '1')).toBe(true);
  });

  it('throws for a settlement id that does not exist on chain', async () => {
    await expect(service.registerOrResync(999_999_999n)).rejects.toThrow(/simulation failed/);
  });
});
