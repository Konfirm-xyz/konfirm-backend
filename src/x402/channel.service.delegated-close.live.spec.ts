import { Account, Address, BASE_FEE, Contract, Keypair, Networks, TransactionBuilder, nativeToScVal, rpc } from '@stellar/stellar-sdk';
import { ChannelService } from './channel.service';
import { NETWORK_PASSPHRASE, RPC_URL, CHANNEL_CONTRACT_ID } from '../common/stellar-network';

// Real testnet RPC, real redeployed channel contract -- 'live' suite, not
// 'fast' (see jest.config.js). Exercises two real, previously-unverified
// fixes (PRD docs/PRD.md M2), both only ever covered by mocked unit tests
// before this:
//
// 1. openChannel() used to rebuild the payer's invokeHostFunction op with
//    the facilitator as the tx's new source account. The payer's own auth
//    entry is source_account-credentialed (correct when the payer really
//    is the tx source, which they are when they build+sign it
//    client-side) -- swapping the source afterward silently reinterprets
//    that credential as authorizing the facilitator instead, and
//    payer.require_auth() traps. Confirmed live: the old rebuild failed
//    open_channel every single time with a generic VM trap. Fixed by
//    fee-bumping the payer's already-signed, already-assembled
//    transaction byte-for-byte instead of rebuilding it -- the
//    Stellar-native mechanism for exactly this "someone else sponsors the
//    fee" case. This test's helper (openRealChannel) goes through the
//    real openChannel() method, so a regression here fails this file at
//    the setup step, not just the assertions below.
// 2. submitFacilitatorCall (used by initiateCloseAsDelegate) rebuilt its
//    operation from scratch via contract.call(), which drops ALL auth
//    entries from simulation, not just reinterprets them --
//    checkpoint()/finalize_close() never noticed (fully permissionless,
//    nothing to drop), but initiate_close() needs caller.require_auth().
//    Fixed with rpc.assembleTransaction in place of a manual
//    sorobanData-only copy -- the parallel treasury-settlement work this
//    session found the identical bug class independently (backend#221).
describe('ChannelService.initiateCloseAsDelegate() (live testnet)', () => {
  const channel = new ChannelService();
  const server = new rpc.Server(RPC_URL);
  const facilitatorAddress = Keypair.fromSecret('SBYXFFJCQSGC4742XGBI6F3YHGRHAWK77VBSBQJSLQNRI7IXTHX6KAAT').publicKey();
  // Native XLM's SAC -- allowed on the redeployed channel contract
  // specifically for this test (friendbot-funded, no SEP-24 deposit flow
  // needed, unlike USDC/EURC).
  const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  async function openRealChannel(delegatedCloser: string | null): Promise<bigint> {
    const payer = Keypair.random();
    const payeeAddress = Keypair.random().publicKey();
    const friendbot = await fetch(`https://friendbot.stellar.org?addr=${payer.publicKey()}`);
    if (!friendbot.ok) throw new Error('friendbot funding failed for throwaway payer');
    await new Promise((r) => setTimeout(r, 3000));

    const payerPubkey = Buffer.alloc(32, 3);
    const contract = new Contract(CHANNEL_CONTRACT_ID);
    const args = [
      new Address(payer.publicKey()).toScVal(),
      new Address(payeeAddress).toScVal(),
      new Address(XLM_SAC).toScVal(),
      nativeToScVal(payerPubkey, { type: 'bytes' }),
      nativeToScVal(10_0000000n, { type: 'i128' }), // 10 XLM
      delegatedCloser === null ? nativeToScVal(null) : new Address(delegatedCloser).toScVal(),
    ];

    const account = await server.getAccount(payer.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .setTimeout(60)
      .addOperation(contract.call('open_channel', ...args))
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new Error('open_channel simulation failed for test setup: ' + JSON.stringify(sim));
    }
    const assembled = rpc.assembleTransaction(tx, sim).build();
    assembled.sign(payer);

    const result = await channel.openChannel({ transactionXdr: assembled.toXDR() });
    if (!result.success || !result.onchainChannelId) {
      throw new Error('openChannel failed for test setup: ' + JSON.stringify(result));
    }
    return BigInt(result.onchainChannelId);
  }

  it('closes a real channel as the delegated closer, after the assembleTransaction fix', async () => {
    const onchainChannelId = await openRealChannel(facilitatorAddress);

    const result = await channel.initiateCloseAsDelegate(onchainChannelId);
    expect(result).toEqual({ success: true, transaction: expect.any(String), returnValue: null });

    const info = (await channel.getChannelInfoOnChain(onchainChannelId)) as { status: string[] | string };
    const status = Array.isArray(info.status) ? info.status[0] : info.status;
    expect(status).toBe('Closing');
  }, 60_000);

  it('is rejected by the contract itself for a channel with no delegation granted', async () => {
    const onchainChannelId = await openRealChannel(null);

    const result = await channel.initiateCloseAsDelegate(onchainChannelId);
    // Not an auth-assembly failure (that bug is fixed) -- a correct,
    // deliberate Unauthorized rejection from the contract, because this
    // channel's delegated_closer is None and the facilitator is neither
    // payer nor payee.
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe('initiate_close_simulation_failed');
  }, 60_000);
});
