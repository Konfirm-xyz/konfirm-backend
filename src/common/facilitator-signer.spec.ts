import { Keypair } from '@stellar/stellar-sdk';
import { assertKmsFacilitatorIsSeparate, assertSeparateHotKeys, withFacilitatorSubmissionLock } from './facilitator-signer';

// Same KMS-client-boundary mock as kms-ed25519-signer.spec.ts: the public key
// fed through it comes from a real keypair, so the derived address is real.
const send = jest.fn();
jest.mock('@aws-sdk/client-kms', () => ({
  KMSClient: jest.fn().mockImplementation(() => ({ send })),
  GetPublicKeyCommand: jest.fn().mockImplementation((input) => ({ __type: 'GetPublicKey', input })),
  SignCommand: jest.fn().mockImplementation((input) => ({ __type: 'Sign', input })),
}));

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function mockKmsFor(keypair: Keypair) {
  send.mockImplementation((command: { __type: string }) => {
    if (command.__type === 'GetPublicKey') {
      return Promise.resolve({ PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, keypair.rawPublicKey()]) });
    }
    throw new Error(`unexpected command ${command.__type}`);
  });
}

describe('assertSeparateHotKeys', () => {
  const a = Keypair.random().secret();
  const b = Keypair.random().secret();
  const c = Keypair.random().secret();

  it('passes when every configured key is a different account', () => {
    expect(() =>
      assertSeparateHotKeys({ STELLAR_DEPLOYER_SECRET_KEY: a, FACILITATOR_SECRET_KEY: b, PLATFORM_FEE_SECRET_KEY: c }),
    ).not.toThrow();
  });

  it('refuses the facilitator reusing the deployer key', () => {
    expect(() => assertSeparateHotKeys({ STELLAR_DEPLOYER_SECRET_KEY: a, FACILITATOR_SECRET_KEY: a })).toThrow(
      /same account/,
    );
  });

  it('refuses the fee account reusing the facilitator key', () => {
    expect(() => assertSeparateHotKeys({ FACILITATOR_SECRET_KEY: b, PLATFORM_FEE_SECRET_KEY: b })).toThrow(/same account/);
  });

  it('rejects something that is not a Stellar secret', () => {
    expect(() => assertSeparateHotKeys({ FACILITATOR_SECRET_KEY: 'not-a-key' })).toThrow(/not a valid Stellar secret/);
  });
});

describe('assertKmsFacilitatorIsSeparate', () => {
  const facilitator = Keypair.random();
  const deployer = Keypair.random();
  const fee = Keypair.random();

  it('passes when the KMS address differs from every configured identity', () => {
    expect(() =>
      assertKmsFacilitatorIsSeparate(facilitator.publicKey(), {
        STELLAR_DEPLOYER_SECRET_KEY: deployer.secret(),
        DEPLOYER_ADDRESS: deployer.publicKey(),
        PLATFORM_FEE_SECRET_KEY: fee.secret(),
        PLATFORM_FEE_ADDRESS: fee.publicKey(),
      }),
    ).not.toThrow();
  });

  it('passes when nothing else is configured', () => {
    expect(() => assertKmsFacilitatorIsSeparate(facilitator.publicKey(), {})).not.toThrow();
  });

  it.each([
    ['STELLAR_DEPLOYER_SECRET_KEY', () => facilitator.secret()],
    ['DEPLOYER_ADDRESS', () => facilitator.publicKey()],
    ['PLATFORM_FEE_SECRET_KEY', () => facilitator.secret()],
    ['PLATFORM_FEE_ADDRESS', () => facilitator.publicKey()],
  ])('refuses the KMS address matching %s', (name, value) => {
    expect(() => assertKmsFacilitatorIsSeparate(facilitator.publicKey(), { [name]: value() })).toThrow(
      new RegExp(`${name} are the same account`),
    );
  });

  it('rejects a deployer secret that is not a Stellar secret', () => {
    expect(() =>
      assertKmsFacilitatorIsSeparate(facilitator.publicKey(), { STELLAR_DEPLOYER_SECRET_KEY: 'not-a-key' }),
    ).toThrow(/not a valid Stellar secret/);
  });
});

describe('getFacilitatorSigner (KMS path)', () => {
  const saved = { ...process.env };

  // getFacilitatorSigner memoizes its promise at module scope, so each case
  // loads a fresh copy of the module.
  function freshGetFacilitatorSigner(): () => Promise<{ address: string }> {
    let fn: () => Promise<{ address: string }> = () => Promise.reject(new Error('not loaded'));
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      fn = require('./facilitator-signer').getFacilitatorSigner;
    });
    return fn;
  }

  beforeEach(() => {
    send.mockReset();
    process.env = { ...saved, FACILITATOR_KMS_KEY_ID: 'test-key-id' };
    delete process.env.STELLAR_DEPLOYER_SECRET_KEY;
    delete process.env.DEPLOYER_ADDRESS;
    delete process.env.PLATFORM_FEE_SECRET_KEY;
    delete process.env.PLATFORM_FEE_ADDRESS;
  });

  afterAll(() => {
    process.env = saved;
  });

  it('resolves when the KMS key is its own account', async () => {
    const kmsKey = Keypair.random();
    mockKmsFor(kmsKey);
    process.env.STELLAR_DEPLOYER_SECRET_KEY = Keypair.random().secret();
    process.env.PLATFORM_FEE_ADDRESS = Keypair.random().publicKey();

    const signer = await freshGetFacilitatorSigner()();
    expect(signer.address).toBe(kmsKey.publicKey());
  });

  it('throws on first resolution when the KMS key is the deployer account', async () => {
    const shared = Keypair.random();
    mockKmsFor(shared);
    process.env.STELLAR_DEPLOYER_SECRET_KEY = shared.secret();

    await expect(freshGetFacilitatorSigner()()).rejects.toThrow(
      /FACILITATOR_KMS_KEY_ID and STELLAR_DEPLOYER_SECRET_KEY are the same account/,
    );
  });

  it('throws on first resolution when the KMS key is the platform-fee account', async () => {
    const shared = Keypair.random();
    mockKmsFor(shared);
    process.env.PLATFORM_FEE_ADDRESS = shared.publicKey();

    await expect(freshGetFacilitatorSigner()()).rejects.toThrow(
      /FACILITATOR_KMS_KEY_ID and PLATFORM_FEE_ADDRESS are the same account/,
    );
  });
});

// ── withFacilitatorSubmissionLock ─────────────────────────────────────────────

describe('withFacilitatorSubmissionLock', () => {
  it('runs calls strictly in order, never overlapping', async () => {
    const order: number[] = [];
    // Three calls that all start before any resolves.
    const p1 = withFacilitatorSubmissionLock(async () => { order.push(1); });
    const p2 = withFacilitatorSubmissionLock(async () => { order.push(2); });
    const p3 = withFacilitatorSubmissionLock(async () => { order.push(3); });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('advances the queue even when an earlier call rejects', async () => {
    const results: string[] = [];
    const reject = withFacilitatorSubmissionLock(() => Promise.reject(new Error('submission failed')));
    const after = withFacilitatorSubmissionLock(async () => { results.push('ran'); });
    await expect(reject).rejects.toThrow('submission failed');
    await after;
    expect(results).toEqual(['ran']);
  });

  it('does not let an earlier rejection prevent a later call from running', async () => {
    const ran: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      withFacilitatorSubmissionLock(() => Promise.reject(new Error(`fail ${i}`))).catch(() => undefined);
    }
    const last = withFacilitatorSubmissionLock(async () => { ran.push(true); });
    await last;
    expect(ran).toEqual([true]);
  });
});
