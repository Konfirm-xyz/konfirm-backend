import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { pool } from '../db/pool';
import { claimPayload } from '../common/channel-claim';
import { concurrentCalls } from '../../test/helpers/concurrent';
import { NETWORK_PASSPHRASE, CHANNEL_CONTRACT_ID } from '../common/stellar-network';
import { ChannelService } from './channel.service';

// Real Postgres (konfirm_test, see test/env.ts) and real Ed25519 signatures.
// claim() makes no RPC call, so nothing here touches the network.
describe('ChannelService.claim() (Postgres)', () => {
  const channel = new ChannelService();
  const channelIds: string[] = [];

  // Raw 32-byte public key, the form x402_channels.payer_pubkey stores (hex).
  function rawPublicKey(publicKey: KeyObject): Buffer {
    return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  }

  async function seedChannel(payerPubkey: Buffer, deposited: bigint): Promise<bigint> {
    // Random, and far above anything a real testnet channel id would reach.
    const onchainChannelId = 9_000_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000_000));
    await pool.query(
      `INSERT INTO x402_channels (onchain_channel_id, payer_address, payee_address, asset_contract, payer_pubkey, deposited)
       VALUES ($1, 'GPAYER', 'GPAYEE', 'CASSET', $2, $3)`,
      [onchainChannelId.toString(), payerPubkey.toString('hex'), deposited.toString()],
    );
    channelIds.push(onchainChannelId.toString());
    return onchainChannelId;
  }

  afterAll(async () => {
    if (channelIds.length > 0) {
      await pool.query('DELETE FROM x402_channels WHERE onchain_channel_id = ANY($1::bigint[])', [channelIds]);
    }
  });

  it('keeps the highest claim when many valid claims race', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const onchainChannelId = await seedChannel(rawPublicKey(publicKey), 1_000_000_000n);
    const claims = Array.from({ length: 30 }, (_, index) => {
      const nonce = BigInt(index + 1);
      const cumulativeAmount = nonce * 1_000n;
      return { nonce, cumulativeAmount, signature: sign(null, claimPayload(onchainChannelId, nonce, cumulativeAmount), privateKey) };
    });

    const results = await concurrentCalls(claims.length, (index) => channel.claim({ onchainChannelId, ...claims[index] }));

    // A claim that lost the race is reported stale, never silently accepted.
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled' && !result.value.accepted) expect(result.value.reason).toBe('stale_claim');
    }
    // Nothing is newer than the last claim, so it can never lose.
    const last = results[results.length - 1];
    expect(last.status === 'fulfilled' && last.value.accepted).toBe(true);

    const { rows } = await pool.query(
      'SELECT pending_nonce::text, pending_amount::text, pending_signature FROM x402_channels WHERE onchain_channel_id = $1',
      [onchainChannelId.toString()],
    );
    expect(rows[0]).toEqual({
      pending_nonce: '30',
      pending_amount: '30000',
      pending_signature: claims[claims.length - 1].signature.toString('hex'),
    });
  });

  it('rejects a lower claim arriving after a higher one', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const onchainChannelId = await seedChannel(rawPublicKey(publicKey), 1_000_000n);
    const signed = (nonce: bigint, cumulativeAmount: bigint) => ({
      onchainChannelId,
      nonce,
      cumulativeAmount,
      signature: sign(null, claimPayload(onchainChannelId, nonce, cumulativeAmount), privateKey),
    });

    await expect(channel.claim(signed(5n, 500n))).resolves.toEqual({ accepted: true });
    await expect(channel.claim(signed(4n, 400n))).resolves.toEqual({ accepted: false, reason: 'stale_claim' });
  });
});

// Covers the facilitator's open_channel validation added for PRD docs/PRD.md
// M2: the deployed contract's real signature is 6 args (payer, payee, token,
// payer_pubkey, deposit, delegated_closer), not the 5 this facilitator used
// to check for — every real open_channel call was being rejected as
// wrong_function before this fix. These tests only cover the checks that
// return before any RPC call (operation shape, arg count, delegated_closer),
// so they run in the 'fast' suite with no network and no simulateTransaction.
describe('ChannelService.openChannel() validation (no network)', () => {
  const channel = new ChannelService();
  const facilitatorAddress = Keypair.fromSecret(process.env.FACILITATOR_SECRET_KEY as string).publicKey();

  // A throwaway, unfunded source account — these paths all return before
  // the transaction would ever need to be submitted or even simulated.
  function buildOpenChannelXdr(args: {
    payer?: string;
    deposit?: bigint;
    delegatedCloser?: string | null;
    argCount?: number;
  }): string {
    const sourceKeypair = Keypair.random();
    const account = new Account(sourceKeypair.publicKey(), '0');
    const payer = args.payer ?? Keypair.random().publicKey();
    const payee = Keypair.random().publicKey();
    const payerPubkey = Buffer.alloc(32, 7);
    const fullArgs = [
      new Address(payer).toScVal(),
      new Address(payee).toScVal(),
      // Any syntactically valid contract address works here — this test
      // only exercises the facilitator's structural parsing, not a real
      // token transfer.
      new Address(CHANNEL_CONTRACT_ID).toScVal(),
      nativeToScVal(payerPubkey, { type: 'bytes' }),
      nativeToScVal(args.deposit ?? 1_000_000n, { type: 'i128' }),
      args.delegatedCloser === undefined
        ? nativeToScVal(null)
        : args.delegatedCloser === null
          ? nativeToScVal(null)
          : new Address(args.delegatedCloser).toScVal(),
    ];
    const contract = new Contract(CHANNEL_CONTRACT_ID);
    const invokeArgs = args.argCount !== undefined ? fullArgs.slice(0, args.argCount) : fullArgs;
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .setTimeout(60)
      .addOperation(contract.call('open_channel', ...invokeArgs))
      .build();
    return tx.toXDR();
  }

  // Blocks the payer locally in Postgres first, so the facilitator rejects
  // with 'compliance_blocked' (pure DB, no network) rather than falling
  // through to isAllowedOnChain's real RPC call — keeping these cases in
  // the 'fast', no-network suite while still proving the arg-shape and
  // delegated_closer checks before it were passed, not failed.
  async function blockAddress(address: string): Promise<void> {
    await pool.query('INSERT INTO blocked_addresses (stellar_address) VALUES ($1) ON CONFLICT DO NOTHING', [address]);
  }
  async function unblockAddress(address: string): Promise<void> {
    await pool.query('DELETE FROM blocked_addresses WHERE stellar_address = $1', [address]);
  }

  it('accepts the real 6-arg signature up to the delegated_closer check (no delegation requested)', async () => {
    const payer = Keypair.random().publicKey();
    await blockAddress(payer);
    try {
      const result = await channel.openChannel({ transactionXdr: buildOpenChannelXdr({ payer, delegatedCloser: null }) });
      expect(result).toEqual({ success: false, errorReason: 'compliance_blocked' });
    } finally {
      await unblockAddress(payer);
    }
  });

  it('rejects the old 5-arg call shape the facilitator used to require', async () => {
    const result = await channel.openChannel({ transactionXdr: buildOpenChannelXdr({ argCount: 5 }) });
    expect(result).toEqual({ success: false, errorReason: 'wrong_function' });
  });

  it('accepts delegated_closer set to this facilitator', async () => {
    const payer = Keypair.random().publicKey();
    await blockAddress(payer);
    try {
      const result = await channel.openChannel({
        transactionXdr: buildOpenChannelXdr({ payer, delegatedCloser: facilitatorAddress }),
      });
      expect(result).toEqual({ success: false, errorReason: 'compliance_blocked' });
    } finally {
      await unblockAddress(payer);
    }
  });

  it('rejects delegated_closer set to anyone other than this facilitator', async () => {
    const someoneElse = Keypair.random().publicKey();
    const result = await channel.openChannel({
      transactionXdr: buildOpenChannelXdr({ delegatedCloser: someoneElse }),
    });
    expect(result).toEqual({ success: false, errorReason: 'delegated_closer_not_facilitator' });
  });

  it('rejects the facilitator itself as payer regardless of delegated_closer', async () => {
    const result = await channel.openChannel({
      transactionXdr: buildOpenChannelXdr({ payer: facilitatorAddress, delegatedCloser: null }),
    });
    expect(result).toEqual({ success: false, errorReason: 'facilitator_is_payer' });
  });
});

// File-level, not per-describe: the pool is a shared module singleton, so
// closing it inside either describe block above would break whichever one
// runs after it.
afterAll(async () => {
  await pool.end();
});
