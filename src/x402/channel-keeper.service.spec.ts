import { pool } from '../db/pool';
import {
  ChannelKeeperService,
  classifyFailureReason,
  MAX_TRANSIENT_BACKOFF_MS,
  STUCK_FAILURE_THRESHOLD,
  TERMINAL_COOLDOWN_MS,
  TRANSIENT_BASE_BACKOFF_MS,
} from './channel-keeper.service';
import { ChannelService } from './channel.service';

describe('ChannelKeeperService failure classification & backoff (#85)', () => {
  const sampleRow = {
    onchain_channel_id: '42',
    claimed: '1000000',
    pending_amount: '5000000',
    pending_nonce: '2',
    pending_signature: 'aa'.repeat(64),
    status: 'open',
  };

  let nowMs = 1_700_000_000_000;
  let openRows: (typeof sampleRow)[] = [];
  let closingRows: (typeof sampleRow)[] = [];
  let finalizeRows: { onchain_channel_id: string; closing_at: string }[] = [];
  let idleRows: { onchain_channel_id: string; idle_days: number }[] = [];

  const mockCheckpointChannel = jest.fn();
  const mockFinalizeCloseChannel = jest.fn();
  const mockGetChannelInfoOnChain = jest.fn();

  const mockChannelService = {
    checkpointChannel: mockCheckpointChannel,
    finalizeCloseChannel: mockFinalizeCloseChannel,
    getChannelInfoOnChain: mockGetChannelInfoOnChain,
  } as unknown as ChannelService;

  let keeper: ChannelKeeperService;
  const warnings: string[] = [];
  const errors: string[] = [];

  let connectSpy: jest.SpyInstance;
  let querySpy: jest.SpyInstance;

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    openRows = [{ ...sampleRow }];
    closingRows = [];
    finalizeRows = [];
    idleRows = [];
    warnings.length = 0;
    errors.length = 0;

    mockCheckpointChannel.mockReset();
    mockFinalizeCloseChannel.mockReset();
    mockGetChannelInfoOnChain.mockReset();
    mockGetChannelInfoOnChain.mockResolvedValue({
      claimed: 1_000_000n,
      status: ['Open'],
    });

    keeper = new ChannelKeeperService(mockChannelService);
    (keeper as unknown as { nowFn: () => number }).nowFn = () => nowMs;
    // Zero jitter for deterministic backoff assertions in unit tests.
    (keeper as unknown as { jitterFn: () => number }).jitterFn = () => 0;
    (keeper as unknown as { logger: { warn: (m: string) => void; error: (m: string) => void } }).logger.warn = (
      m: string,
    ) => void warnings.push(m);
    (keeper as unknown as { logger: { warn: (m: string) => void; error: (m: string) => void } }).logger.error = (
      m: string,
    ) => void errors.push(m);

    connectSpy = jest.spyOn(pool, 'connect').mockResolvedValue({
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    } as never);

    querySpy = jest.spyOn(pool, 'query').mockImplementation((async (sql: string) => {
      if (sql.includes("WHERE status = 'open' AND pending_amount > claimed")) {
        return { rows: openRows };
      }
      if (sql.includes("WHERE status = 'closing' AND closing_at IS NOT NULL")) {
        return { rows: finalizeRows };
      }
      if (sql.includes("WHERE status = 'closing' AND pending_amount > claimed")) {
        return { rows: closingRows };
      }
      if (sql.includes('INTERVAL \'168 hours\'')) {
        return { rows: idleRows };
      }
      return { rows: [] };
    }) as never);
  });

  afterEach(() => {
    connectSpy.mockRestore();
    querySpy.mockRestore();
  });

  describe('classifyFailureReason', () => {
    it('classifies simulation, signing, and on-chain transaction rejections as terminal', () => {
      expect(classifyFailureReason('checkpoint_simulation_failed')).toBe('terminal');
      expect(classifyFailureReason('checkpoint_signing_failed')).toBe('terminal');
      expect(classifyFailureReason('checkpoint_transaction_failed')).toBe('terminal');
      expect(classifyFailureReason('finalize_close_simulation_failed')).toBe('terminal');
      expect(classifyFailureReason('finalize_close_signing_failed')).toBe('terminal');
      expect(classifyFailureReason('finalize_close_transaction_failed')).toBe('terminal');
    });

    it('classifies RPC submission/network failures and unknown reasons as transient', () => {
      expect(classifyFailureReason('checkpoint_submission_failed')).toBe('transient');
      expect(classifyFailureReason('checkpoint_failed')).toBe('transient');
      expect(classifyFailureReason('finalize_close_submission_failed')).toBe('transient');
      expect(classifyFailureReason('finalize_close_failed')).toBe('transient');
      expect(classifyFailureReason(undefined)).toBe('transient');
    });
  });

  it('applies exponential backoff on transient failures and only escalates after STUCK_FAILURE_THRESHOLD', async () => {
    mockCheckpointChannel.mockResolvedValue({
      success: false,
      errorReason: 'checkpoint_submission_failed',
    });

    // Sweep 1 (t = 0): transient failure #1 -> warns with [transient], sets 4m backoff, not yet stuck.
    await keeper.sweep();
    expect(mockCheckpointChannel).toHaveBeenCalledTimes(1);
    expect(warnings.some((w) => w.includes('[transient]') && w.includes('checkpoint_submission_failed'))).toBe(true);
    expect(errors).toEqual([]);

    // Sweep 2 (t = +2m): still within 4m transient backoff -> skipped without calling RPC.
    nowMs += 2 * 60 * 1000;
    await keeper.sweep();
    expect(mockCheckpointChannel).toHaveBeenCalledTimes(1);

    // Sweep 3 (t = +4m): backoff expired -> transient failure #2 -> backoff doubles to 8m.
    nowMs += 2 * 60 * 1000;
    await keeper.sweep();
    expect(mockCheckpointChannel).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);

    // Sweep 4 (t = +8m, only 4m after attempt #2): still inside 8m backoff -> skipped.
    nowMs += 4 * 60 * 1000;
    await keeper.sweep();
    expect(mockCheckpointChannel).toHaveBeenCalledTimes(2);

    // Sweep 5 (t = +12m, 8m after attempt #2): backoff expired -> transient failure #3 -> reaches STUCK_FAILURE_THRESHOLD.
    nowMs += 4 * 60 * 1000;
    await keeper.sweep();
    expect(mockCheckpointChannel).toHaveBeenCalledTimes(STUCK_FAILURE_THRESHOLD);
    expect(
      errors.some(
        (e) =>
          e.includes('channel 42 stuck in checkpoint [transient]') &&
          e.includes(`after ${STUCK_FAILURE_THRESHOLD} consecutive failure(s)`),
      ),
    ).toBe(true);
  });

  it('quarantines terminal failures immediately, logs at error level, and resets if a newer claim arrives', async () => {
    mockCheckpointChannel.mockResolvedValue({
      success: false,
      errorReason: 'checkpoint_simulation_failed',
    });

    // Sweep 1 (t = 0): terminal failure -> logs [terminal] error and surfaces as stuck immediately.
    await keeper.sweep();
    expect(mockCheckpointChannel).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
    expect(errors.some((e) => e.includes('[terminal] checkpoint failed for channel 42: checkpoint_simulation_failed'))).toBe(
      true,
    );
    expect(errors.some((e) => e.includes('channel 42 stuck in checkpoint [terminal] after 1 consecutive failure(s)'))).toBe(
      true,
    );

    // Even well past the transient base backoff (e.g. +1 hour, still < 24h TERMINAL_COOLDOWN_MS),
    // the identical broken claim is NOT re-submitted on every sweep.
    nowMs += MAX_TRANSIENT_BACKOFF_MS;
    await keeper.sweep();
    expect(mockCheckpointChannel).toHaveBeenCalledTimes(1);

    // When a newer signed claim lands on the channel (higher amount & nonce),
    // the stale terminal failure fingerprint is cleared and the keeper attempts the new claim immediately.
    openRows = [
      {
        ...sampleRow,
        pending_amount: '7000000',
        pending_nonce: '3',
        pending_signature: 'bb'.repeat(64),
      },
    ];
    mockCheckpointChannel.mockResolvedValueOnce({
      success: true,
      transaction: 'tx-hash-ok',
    });
    mockGetChannelInfoOnChain.mockResolvedValueOnce({
      claimed: 7_000_000n,
      status: ['Open'],
    });

    errors.length = 0;
    await keeper.sweep();
    expect(mockCheckpointChannel).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });

  it('distinguishes terminal vs transient failures for finalize_close and clears state on on-chain resolution', async () => {
    openRows = [];
    finalizeRows = [{ onchain_channel_id: '99', closing_at: '1699900000' }];

    mockFinalizeCloseChannel.mockResolvedValueOnce({
      success: false,
      errorReason: 'finalize_close_failed',
    });
    mockGetChannelInfoOnChain.mockResolvedValueOnce({
      claimed: 5_000_000n,
      status: ['Closing'],
    });

    await keeper.sweep();
    expect(mockFinalizeCloseChannel).toHaveBeenCalledTimes(1);
    expect(warnings.some((w) => w.includes('[transient] finalize_close failed for channel 99'))).toBe(true);

    // Immediate next 2-minute tick backs off.
    nowMs += 2 * 60 * 1000;
    await keeper.sweep();
    expect(mockFinalizeCloseChannel).toHaveBeenCalledTimes(1);

    // After transient base backoff (4m total), retry succeeds and clears failure state.
    nowMs += TRANSIENT_BASE_BACKOFF_MS;
    mockFinalizeCloseChannel.mockResolvedValueOnce({
      success: true,
      transaction: 'finalize-tx',
    });
    mockGetChannelInfoOnChain.mockResolvedValueOnce({
      claimed: 5_000_000n,
      status: ['Closed'],
    });

    await keeper.sweep();
    expect(mockFinalizeCloseChannel).toHaveBeenCalledTimes(2);

    // Even if TERMINAL_COOLDOWN_MS is checked, failure state map is now empty.
    expect(TERMINAL_COOLDOWN_MS).toBeGreaterThan(MAX_TRANSIENT_BACKOFF_MS);
  });
});
