import { Client } from '@stellar/stellar-sdk/contract';
import { pool } from '../db/pool';
import { TREASURY_CONTRACT_ID } from '../common/stellar-network';
import { FeeCollectionSweepService } from './fee-collection-sweep.service';
import { FacilitatorHalted, type FacilitatorSpendGuardService } from './facilitator-spend-guard.service';

// The advisory lock runs against real Postgres (konfirm_test, see
// test/env.ts). The USDC balance read, the signer and the transfer itself
// are stubbed, so nothing here touches the network.
jest.mock('@stellar/stellar-sdk/contract', () => {
  const original = jest.requireActual('@stellar/stellar-sdk/contract');
  return { ...original, Client: { ...original.Client, from: jest.fn() } };
});

jest.mock('../common/platform-fee', () => ({
  getFeeCollectionSigner: jest.fn(() => ({ address: 'GBJG2IGPXJ673TMTQMMJCSMITNSLVTIJ62MRSHCTQTTGNLV75TFR5PHY' })),
}));

// Must match SWEEP_LOCK_KEY in fee-collection-sweep.service.ts.
const SWEEP_LOCK_KEY = 402_003;

describe('FeeCollectionSweepService', () => {
  const usdc = { balance: jest.fn() };
  const spendGuard = { checkAndRecordSpend: jest.fn() };
  const service = new FeeCollectionSweepService(spendGuard as unknown as FacilitatorSpendGuardService);
  const originalMin = process.env.PLATFORM_FEE_SWEEP_MIN_USDC_BALANCE;
  let submitTransfer: jest.SpyInstance;

  beforeEach(() => {
    (Client.from as jest.Mock).mockResolvedValue(usdc);
    usdc.balance.mockReset();
    spendGuard.checkAndRecordSpend.mockReset().mockResolvedValue(undefined);
    submitTransfer = jest.spyOn(service as any, 'submitTransfer').mockResolvedValue({ success: true, transaction: 'tx-hash' });
    process.env.PLATFORM_FEE_SWEEP_MIN_USDC_BALANCE = '1';
  });

  afterEach(() => {
    submitTransfer.mockRestore();
    if (originalMin === undefined) delete process.env.PLATFORM_FEE_SWEEP_MIN_USDC_BALANCE;
    else process.env.PLATFORM_FEE_SWEEP_MIN_USDC_BALANCE = originalMin;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('does nothing when no minimum balance is configured', async () => {
    delete process.env.PLATFORM_FEE_SWEEP_MIN_USDC_BALANCE;
    await service.sweep();
    expect(usdc.balance).not.toHaveBeenCalled();
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('skips the run while another sweep holds the lock', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [SWEEP_LOCK_KEY]);
      await service.sweep();
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [SWEEP_LOCK_KEY]);
      holder.release();
    }
    expect(usdc.balance).not.toHaveBeenCalled();
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('moves nothing when the balance is at or below the minimum', async () => {
    usdc.balance.mockResolvedValue({ result: 10_000_000n }); // exactly 1 USDC
    await service.sweep();
    expect(spendGuard.checkAndRecordSpend).not.toHaveBeenCalled();
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('submits the transfer before recording spend — a failed transfer does not consume cap budget', async () => {
    usdc.balance.mockResolvedValue({ result: 35_000_000n });
    submitTransfer.mockResolvedValueOnce({ success: false, errorReason: 'rpc timeout' });
    await expect(service.sweep()).resolves.toBeUndefined();
    expect(submitTransfer).toHaveBeenCalledWith(expect.any(String), 25_000_000n);
    // Spend must NOT be recorded when the transfer failed.
    expect(spendGuard.checkAndRecordSpend).not.toHaveBeenCalled();
  });

  it('when the spend guard halts after a successful transfer, logs the conflict and does not throw', async () => {
    usdc.balance.mockResolvedValue({ result: 35_000_000n });
    spendGuard.checkAndRecordSpend.mockRejectedValue(new FacilitatorHalted('halted'));
    await expect(service.sweep()).resolves.toBeUndefined();
    // Transfer still happened (money moved) — guard rejects recording after the fact.
    expect(submitTransfer).toHaveBeenCalledWith(expect.any(String), 25_000_000n);
  });

  it('sweeps everything above the minimum once the guard allows it', async () => {
    usdc.balance.mockResolvedValue({ result: 35_000_000n });
    await service.sweep();
    // Transfer submitted first, then spend recorded.
    expect(submitTransfer).toHaveBeenCalledWith(expect.any(String), 25_000_000n);
    expect(spendGuard.checkAndRecordSpend).toHaveBeenCalledWith(2.5, 'fee-sweep', TREASURY_CONTRACT_ID);
  });
});
