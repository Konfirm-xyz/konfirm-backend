import { Keypair, TransactionBuilder, Networks, Operation, Account } from '@stellar/stellar-sdk';

// Only the KMS *client boundary* is mocked -- the public key and signature
// fed through it are produced by a real, locally-generated Ed25519
// keypair, so this proves the actual cryptographic wiring (SPKI unwrap,
// address encoding, hash-then-attach) is correct, not just that a fake
// value round-trips. Same standard channel-claim.spec.ts already holds
// itself to for crypto-correctness-critical code (test against a real
// signed vector, not a fabricated one) -- generated fresh here instead of
// a fixed baked-in vector since there's no contract-side test this needs
// to match byte-for-byte.
const send = jest.fn();
jest.mock('@aws-sdk/client-kms', () => ({
  KMSClient: jest.fn().mockImplementation(() => ({ send })),
  GetPublicKeyCommand: jest.fn().mockImplementation((input) => ({ __type: 'GetPublicKey', input })),
  SignCommand: jest.fn().mockImplementation((input) => ({ __type: 'Sign', input })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createKmsEd25519Signer } = require('./kms-ed25519-signer');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const NETWORK_PASSPHRASE = Networks.TESTNET;

function mockKmsFor(keypair: Keypair) {
  send.mockImplementation((command: { __type: string }) => {
    if (command.__type === 'GetPublicKey') {
      return Promise.resolve({ PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, keypair.rawPublicKey()]) });
    }
    if (command.__type === 'Sign') {
      const { Message } = (command as unknown as { input: { Message: Buffer } }).input;
      return Promise.resolve({ Signature: keypair.sign(Buffer.from(Message)) });
    }
    throw new Error(`unexpected command ${command.__type}`);
  });
}

describe('createKmsEd25519Signer', () => {
  beforeEach(() => send.mockReset());

  it('derives the exact same G-address a real keypair would have, from KMS\'s public key response', async () => {
    const keypair = Keypair.random();
    mockKmsFor(keypair);

    const signer = await createKmsEd25519Signer('test-key-id');
    expect(signer.address).toBe(keypair.publicKey());
  });

  it('produces a transaction the SDK itself validates as correctly signed by that address', async () => {
    const keypair = Keypair.random();
    mockKmsFor(keypair);
    const signer = await createKmsEd25519Signer('test-key-id');

    const account = new Account(signer.address, '0');
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.bumpSequence({ bumpTo: '1' }))
      .setTimeout(30)
      .build();

    const { signedTxXdr, error } = await signer.signTransaction(tx.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE });
    expect(error).toBeUndefined();

    // TransactionBuilder.fromXDR + checking .signatures directly proves the
    // attached DecoratedSignature really did come from this keypair/hash --
    // Transaction.addSignature() (called inside signTransaction) already
    // refused to attach it if it didn't validate, so reaching this line
    // with a populated signatures array is itself the correctness check.
    const rebuilt = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
    expect(rebuilt.signatures.length).toBe(1);
  });

  it('fails closed with an error result, not a thrown exception, when networkPassphrase is missing', async () => {
    const keypair = Keypair.random();
    mockKmsFor(keypair);
    const signer = await createKmsEd25519Signer('test-key-id');

    const account = new Account(signer.address, '0');
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.bumpSequence({ bumpTo: '1' }))
      .setTimeout(30)
      .build();

    const result = await signer.signTransaction(tx.toXDR());
    expect(result.error).toBeDefined();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ __type: 'Sign' }));
  });

  it('surfaces an unreachable KMS as an error result rather than throwing out of signTransaction', async () => {
    const keypair = Keypair.random();
    mockKmsFor(keypair);
    const signer = await createKmsEd25519Signer('test-key-id');
    send.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'GetPublicKey') {
        return Promise.resolve({ PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, keypair.rawPublicKey()]) });
      }
      return Promise.reject(new Error('KMS unreachable'));
    });

    const account = new Account(signer.address, '0');
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.bumpSequence({ bumpTo: '1' }))
      .setTimeout(30)
      .build();

    const result = await signer.signTransaction(tx.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE });
    expect(result.error?.message).toContain('KMS unreachable');
  });

  it('rejects a malformed public key length rather than silently deriving a wrong address', async () => {
    send.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'GetPublicKey') {
        return Promise.resolve({ PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.alloc(16)]) });
      }
      throw new Error('unexpected');
    });
    await expect(createKmsEd25519Signer('test-key-id')).rejects.toThrow('unexpected Ed25519 public key length');
  });

  it('rejects a 63-byte signature from KMS rather than silently attaching a corrupt one (#368)', async () => {
    const keypair = Keypair.random();
    send.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'GetPublicKey') {
        return Promise.resolve({ PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, keypair.rawPublicKey()]) });
      }
      if (command.__type === 'Sign') {
        // Return a 63-byte signature — one byte short of the required 64.
        return Promise.resolve({ Signature: keypair.sign(Buffer.alloc(32)).slice(0, 63) });
      }
      throw new Error(`unexpected command ${command.__type}`);
    });
    const signer = await createKmsEd25519Signer('test-key-id');

    const account = new Account(signer.address, '0');
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.bumpSequence({ bumpTo: '1' }))
      .setTimeout(30)
      .build();

    const result = await signer.signTransaction(tx.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE });
    expect(result.error?.message).toMatch(/unexpected Ed25519 signature length.*63.*64/);
  });

  it('signAuthEntry throws rather than silently producing an invalid result, since it has no real implementation yet', async () => {
    const keypair = Keypair.random();
    mockKmsFor(keypair);
    const signer = await createKmsEd25519Signer('test-key-id');
    await expect(signer.signAuthEntry('irrelevant')).rejects.toThrow('no implementation yet');
  });
});
