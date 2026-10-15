import { PaymentAttestationSweeperService } from './payment-attestation-sweeper.service';
import type { PaymentAttestationService } from './payment-attestation.service';
import { pool } from '../db/pool';

describe('PaymentAttestationSweeperService (#67)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not call attest() a second time when the DB UPDATE throws after a successful on-chain attestation', async () => {
    const mockAttest = jest.fn().mockResolvedValue({
      success: true,
      onchainPaymentId: '42',
      transaction: 'abc123',
    });
    const attestationService = {
      attest: mockAttest,
    } as unknown as PaymentAttestationService;

    const sweeper = new PaymentAttestationSweeperService(attestationService);

    const mockClient = {
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    jest.spyOn(pool, 'connect').mockResolvedValue(mockClient as never);

    const dueRow = {
      id: 'pay-1',
      payer_address: 'GPAYER12345678901234567890123456789012345678901234567890',
      muxed_id: '777',
      net_usdc: '10.0000000',
      tx_hash: '00'.repeat(32),
      onchain_payment_id: null,
      merchant_address: 'GMERCH12345678901234567890123456789012345678901234567890',
    };

    const querySpy = jest
      .spyOn(pool, 'query')
      // Sweep 1: SELECT due rows -> returns dueRow
      .mockResolvedValueOnce({ rows: [dueRow] } as never)
      // Sweep 1: UPDATE payments -> transient DB failure after attest() succeeded!
      .mockRejectedValueOnce(new Error('transient connection reset during UPDATE') as never)
      // Sweep 2: SELECT due rows -> returns the same unattested row
      .mockResolvedValueOnce({ rows: [dueRow] } as never)
      // Sweep 2: UPDATE payments -> succeeds
      .mockResolvedValueOnce({ rows: [] } as never);

    // First sweep: attest() succeeds, UPDATE throws
    await sweeper.sweep();
    expect(mockAttest).toHaveBeenCalledTimes(1);

    // Second sweep: UPDATE is retried using the cached onchainPaymentId without calling attest() again
    await sweeper.sweep();
    expect(mockAttest).toHaveBeenCalledTimes(1);
    expect(querySpy).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE payments SET onchain_payment_id = $2, attested_at = NOW() WHERE id = $1'),
      ['pay-1', '42'],
    );
  });
});
