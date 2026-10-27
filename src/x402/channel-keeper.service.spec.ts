import { Keypair } from '@stellar/stellar-sdk';
import { pool } from '../db/pool';
import { ChannelKeeperService, classifyKeeperFailure, keeperBackoffMs } from './channel-keeper.service';
import type { ChannelService, FacilitatorCallResult } from './channel.service';

describe('classifyKeeperFailure', () => {
  it.each([
    ['checkpoint_simulation_failed', 'terminal'],
    ['checkpoint_transaction_failed', 'terminal'],
    ['finalize_close_simulation_failed', 'terminal'],
    ['finalize_close_transaction_failed', 'terminal'],
    ['checkpoint_signing_failed', 'transient'],
    ['checkpoint_submission_failed', 'transient'],
    ['checkpoint_failed', 'transient'],
    ['checkpoint_confirmation_timeout', 'transient'],
    ['something_unrecognised', 'transient'],
    [undefined, 'transient'],
  ])('%s -> %s', (reason, kind) => {
    expect(classifyKeeperFailure(reason)).toBe(kind);
  });
});

describe('keeperBackoffMs', () => {
  const noJitter = () => 0.5;
  const minute = 60_000;

  it('backs a transient failure off exponentially from one sweep interval, up to a cap', () => {
    expect(keeperBackoffMs('transient', 1, noJitter)).toBe(2 * minute);
    expect(keeperBackoffMs('transient', 2, noJitter)).toBe(4 * minute);
    expect(keeperBackoffMs('transient', 3, noJitter)).toBe(8 * minute);
    expect(keeperBackoffMs('transient', 10, noJitter)).toBe(60 * minute);
  });

  it('sends a terminal failure straight to the cap', () => {
    expect(keeperBackoffMs('terminal', 1, noJitter)).toBe(60 * minute);
  });

  it('jitters within +/-20%', () => {
    expect(keeperBackoffMs('transient', 1, () => 0)).toBe(96_000);
    expect(keeperBackoffMs('transient', 1, () => 1)).toBe(144_000);
  });
});

// Real Postgres (konfirm_test), same convention as the other DB-backed
// specs. Only the on-chain side is stubbed: ChannelService talks to Soroban
// RPC, and the point here is how the keeper reacts to each kind of result.
describe('ChannelKeeperService failure handling', () => {
  const terminalId = 9_100_000_000 + (Date.now() % 1_000_000);
  const transientId = terminalId + 1;
  const outcomes = new Map<string, FacilitatorCallResult>();
  const checkpointCalls: string[] = [];
  const fakeChannel = {
    checkpointChannel: async (params: { onchainChannelId: bigint }) => {
      checkpointCalls.push(params.onchainChannelId.toString());
      return outcomes.get(params.onchainChannelId.toString()) ?? { success: true };
    },
    finalizeCloseChannel: async () => ({ success: true }),
    // Resync failing leaves the rows exactly as the keeper's own
    // bookkeeping wrote them, which is what these tests inspect.
    getChannelInfoOnChain: async () => {
      throw new Error('no RPC in tests');
    },
  } as unknown as ChannelService;
  const keeper = new ChannelKeeperService(fakeChannel);
  const logger = (keeper as unknown as { logger: { error: (m: string) => void; warn: (m: string) => void } }).logger;
  const realError = logger.error;
  const realWarn = logger.warn;
  const errors: string[] = [];
  const warnings: string[] = [];

  async function insertChannel(onchainId: number): Promise<void> {
    await pool.query(
      `INSERT INTO x402_channels
         (onchain_channel_id, payer_address, payee_address, asset_contract, payer_pubkey, deposited,
          claimed, pending_amount, pending_nonce, pending_signature)
       VALUES ($1, 'GPAYER', 'GPAYEE', 'CASSET', 'ab', 1000, 0, 100, 1, 'abcd')`,
      [onchainId],
    );
  }

  async function keeperState(onchainId: number) {
    const { rows } = await pool.query<{
      keeper_failure_count: number;
      keeper_last_error: string | null;
      keeper_last_error_kind: string | null;
      next_attempt_in_secs: number | null;
    }>(
      `SELECT keeper_failure_count, keeper_last_error, keeper_last_error_kind,
              EXTRACT(EPOCH FROM keeper_next_attempt_at - NOW())::float AS next_attempt_in_secs
       FROM x402_channels WHERE onchain_channel_id = $1`,
      [onchainId],
    );
    return rows[0];
  }

  beforeEach(async () => {
    errors.length = 0;
    warnings.length = 0;
    checkpointCalls.length = 0;
    outcomes.clear();
    logger.error = (m: string) => void errors.push(m);
    logger.warn = (m: string) => void warnings.push(m);
    await insertChannel(terminalId);
    await insertChannel(transientId);
  });

  afterEach(async () => {
    logger.error = realError;
    logger.warn = realWarn;
    await pool.query('DELETE FROM x402_channels WHERE onchain_channel_id IN ($1, $2)', [terminalId, transientId]);
  });

  it('handles a terminal and a transient failure differently, and backs both off', async () => {
    outcomes.set(String(terminalId), { success: false, errorReason: 'checkpoint_simulation_failed' });
    outcomes.set(String(transientId), { success: false, errorReason: 'checkpoint_confirmation_timeout' });

    await keeper.sweep();

    const terminal = await keeperState(terminalId);
    expect(terminal.keeper_failure_count).toBe(1);
    expect(terminal.keeper_last_error_kind).toBe('terminal');
    expect(terminal.keeper_last_error).toBe('checkpoint_simulation_failed');
    // Straight to the 1h cap (minus jitter), not the next 2-minute tick.
    expect(terminal.next_attempt_in_secs).toBeGreaterThan(45 * 60);

    const transient = await keeperState(transientId);
    expect(transient.keeper_failure_count).toBe(1);
    expect(transient.keeper_last_error_kind).toBe('transient');
    expect(transient.keeper_last_error).toBe('checkpoint_confirmation_timeout');
    expect(transient.next_attempt_in_secs).toBeGreaterThan(60);
    expect(transient.next_attempt_in_secs).toBeLessThan(3 * 60);

    // Distinguishable in logs: terminal is an error, transient a warning.
    expect(errors.some((m) => m.includes(`(terminal) for channel ${terminalId}`))).toBe(true);
    expect(warnings.some((m) => m.includes(`(transient) for channel ${transientId}`))).toBe(true);
    expect(errors.some((m) => m.includes(`(transient) for channel ${transientId}`))).toBe(false);

    // An immediate second sweep respects the backoff and doesn't resubmit.
    checkpointCalls.length = 0;
    await keeper.sweep();
    expect(checkpointCalls).not.toContain(String(terminalId));
    expect(checkpointCalls).not.toContain(String(transientId));
  });

  it('grows a repeated transient backoff and reports the channel as stuck past the threshold', async () => {
    outcomes.set(String(transientId), { success: false, errorReason: 'checkpoint_failed' });
    // Simulate four earlier failures whose backoff has now elapsed.
    await pool.query(
      `UPDATE x402_channels SET keeper_failure_count = 4, keeper_next_attempt_at = NOW() - INTERVAL '1 second'
       WHERE onchain_channel_id = $1`,
      [transientId],
    );

    await keeper.sweep();

    const state = await keeperState(transientId);
    expect(state.keeper_failure_count).toBe(5);
    // 2min * 2^4 = 32min, +/-20%.
    expect(state.next_attempt_in_secs).toBeGreaterThan(25 * 60);
    expect(errors.some((m) => m.includes(`channel ${transientId} (open) stuck: 5 consecutive`))).toBe(true);
  });

  it('clears the failure state on success', async () => {
    await pool.query(
      `UPDATE x402_channels
       SET keeper_failure_count = 3, keeper_last_error = 'checkpoint_failed', keeper_last_error_kind = 'transient',
           keeper_next_attempt_at = NOW() - INTERVAL '1 second'
       WHERE onchain_channel_id = $1`,
      [transientId],
    );

    await keeper.sweep();

    const state = await keeperState(transientId);
    expect(state.keeper_failure_count).toBe(0);
    expect(state.keeper_last_error).toBeNull();
    expect(state.keeper_last_error_kind).toBeNull();
    expect(state.next_attempt_in_secs).toBeNull();
  });
});

// Covers sweepIdleClose(), added for PRD docs/PRD.md M2: the previous
// comment block here said idle-close could never be implemented without a
// contract change (the facilitator is neither channel party, so it had no
// authority to call initiate_close). The redeployed channel contract now
// accepts a delegated_closer, so this proves the keeper actually uses it —
// closing a channel delegated to it, and leaving a non-delegated one alone
// for logIdleChannels() to merely report.
describe('ChannelKeeperService.sweepIdleClose()', () => {
  const facilitatorAddress = Keypair.fromSecret(process.env.FACILITATOR_SECRET_KEY as string).publicKey();
  const delegatedId = 9_200_000_000 + (Date.now() % 1_000_000);
  const notDelegatedId = delegatedId + 1;
  const initiateCloseCalls: string[] = [];
  const fakeChannel = {
    initiateCloseAsDelegate: async (onchainChannelId: bigint) => {
      initiateCloseCalls.push(onchainChannelId.toString());
      return { success: true };
    },
    checkpointChannel: async () => ({ success: true }),
    finalizeCloseChannel: async () => ({ success: true }),
    getChannelInfoOnChain: async () => {
      throw new Error('no RPC in tests');
    },
  } as unknown as ChannelService;
  const keeper = new ChannelKeeperService(fakeChannel);

  async function insertIdleChannel(onchainId: number, delegatedCloser: string | null): Promise<void> {
    await pool.query(
      `INSERT INTO x402_channels
         (onchain_channel_id, payer_address, payee_address, asset_contract, payer_pubkey, deposited,
          delegated_closer, last_activity_at)
       VALUES ($1, 'GPAYER', 'GPAYEE', 'CASSET', 'ab', 1000, $2, NOW() - INTERVAL '169 hours')`,
      [onchainId, delegatedCloser],
    );
  }

  beforeEach(async () => {
    initiateCloseCalls.length = 0;
    await insertIdleChannel(delegatedId, facilitatorAddress);
    await insertIdleChannel(notDelegatedId, null);
  });

  afterEach(async () => {
    await pool.query('DELETE FROM x402_channels WHERE onchain_channel_id IN ($1, $2)', [delegatedId, notDelegatedId]);
  });

  it('closes an idle channel delegated to this facilitator, and leaves a non-delegated one alone', async () => {
    await keeper.sweep();

    expect(initiateCloseCalls).toEqual([String(delegatedId)]);
    expect(initiateCloseCalls).not.toContain(String(notDelegatedId));
  });
});

// File-level, not per-describe: the pool is a shared module singleton, so
// closing it inside any one describe block above would break whichever one
// runs after it.
afterAll(async () => {
  await pool.end();
});
