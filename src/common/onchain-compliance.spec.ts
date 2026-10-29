import { isAllowedOnChain, checkComplianceCanary } from './onchain-compliance';

// Mock the Client.from() and the contract call — using the same approach
// as kms-ed25519-signer.spec.ts where AWS SDK is mocked. The contract call
// is wrapped by withRetry() and timeout, so both the client construction
// and the call inside getClient() must be mockable.
jest.mock('@stellar/stellar-sdk/contract', () => {
  const sendMock = jest.fn();
  return {
    Client: {
      from: jest.fn().mockImplementation(() => {
        return Promise.resolve({
          is_allowed: jest.fn().mockImplementation(() => {
            return sendMock();
          }),
          _sendMock: sendMock, // Expose for test manipulation
        });
      }),
    },
  };
});

describe('onchain-compliance.isAllowedOnChain', () => {
  let Client: any;
  let sendMock: jest.Mock;

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Client = require('@stellar/stellar-sdk/contract').Client;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules(); // Reset the module to clear clientPromise between tests
    // Re-require after reset to get fresh clientPromise state
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('./onchain-compliance');
  });

  it('returns the real result on successful on-chain check', async () => {
    const mockClient = {
      is_allowed: jest.fn().mockResolvedValue({
        result: false, // Address is not allowed
      }),
    };
    Client.from.mockResolvedValueOnce(mockClient);

    const result = await isAllowedOnChain('GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL');
    expect(result).toBe(false);
  });

  it('returns true and logs a warning when RPC rejects the call', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const mockClient = {
      is_allowed: jest.fn().mockRejectedValue(new Error('RPC unavailable')),
    };
    Client.from.mockResolvedValueOnce(mockClient);

    const result = await isAllowedOnChain('GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL');
    expect(result).toBe(true); // Fails open
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[compliance] on-chain check unreachable, failing open'),
      expect.any(Error),
    );

    consoleWarnSpy.mockRestore();
  });

  it('clears clientPromise on failure so subsequent calls get a fresh client', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const mockClientBad = {
      is_allowed: jest.fn().mockRejectedValue(new Error('First call fails')),
    };
    const mockClientGood = {
      is_allowed: jest.fn().mockResolvedValue({ result: true }),
    };

    // First call fails
    Client.from.mockResolvedValueOnce(mockClientBad);
    const firstResult = await isAllowedOnChain('GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL');
    expect(firstResult).toBe(true);

    // After cache was cleared, second call should re-create client and succeed
    // Re-import to get the fresh module with cleared clientPromise
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isAllowedOnChain: isAllowedOnChainFresh } = require('./onchain-compliance');
    Client.from.mockResolvedValueOnce(mockClientGood);
    const secondResult = await isAllowedOnChainFresh('GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL');
    expect(secondResult).toBe(true);
    expect(mockClientGood.is_allowed).toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });

  it('respects retry and timeout options from withRetry', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    // Simulate a call that would timeout (takes longer than 8s timeout)
    const mockClient = {
      is_allowed: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ result: true }), 15000); // Longer than 8s timeout
          }),
      ),
    };
    Client.from.mockResolvedValueOnce(mockClient);

    // The withRetry wrapper should timeout this call
    const result = await isAllowedOnChain('GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL');
    expect(result).toBe(true); // Fails open on timeout
    expect(consoleWarnSpy).toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });
});

describe('onchain-compliance.checkComplianceCanary (backend#210)', () => {
  const ORIGINAL_CANARY_ENV = process.env.COMPLIANCE_CANARY_ADDRESS;

  // jest.resetModules() makes the *next* require() of a jest.mock()'d
  // module re-invoke its factory, producing a brand-new Client.from mock
  // distinct from any reference captured before the reset (the pre-existing
  // "clears clientPromise on failure" test above has this exact bug, which
  // is why it already fails independently of this change — confirmed
  // against a clean `git stash` baseline). Re-requiring both the mock and
  // the module under test together, every time, after every reset, avoids
  // it rather than reproducing it.
  function freshModules() {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Client = require('@stellar/stellar-sdk/contract').Client;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const onchainCompliance = require('./onchain-compliance');
    return { Client, onchainCompliance };
  }

  afterEach(() => {
    if (ORIGINAL_CANARY_ENV === undefined) delete process.env.COMPLIANCE_CANARY_ADDRESS;
    else process.env.COMPLIANCE_CANARY_ADDRESS = ORIGINAL_CANARY_ENV;
  });

  it('reports not configured, and skips the on-chain call, when no canary address is set', async () => {
    delete process.env.COMPLIANCE_CANARY_ADDRESS;
    const { Client, onchainCompliance } = freshModules();

    const result = await onchainCompliance.checkComplianceCanary();
    expect(result).toEqual({ configured: false, ok: null });
    expect(Client.from).not.toHaveBeenCalled();
  });

  it('reports ok: true when the canary address correctly reads as blocked', async () => {
    process.env.COMPLIANCE_CANARY_ADDRESS = 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL';
    const { Client, onchainCompliance } = freshModules();
    Client.from.mockResolvedValueOnce({
      is_allowed: jest.fn().mockResolvedValue({ result: false }), // blocked, as expected
    });

    const result = await onchainCompliance.checkComplianceCanary();
    expect(result).toEqual({ configured: true, ok: true });
  });

  it('simulates the deploy-pipeline bug backend#210 describes: reports ok: false and logs a distinct alert when the canary is wrongly allowed', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    process.env.COMPLIANCE_CANARY_ADDRESS = 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL';
    const { Client, onchainCompliance } = freshModules();
    // An uninitialized (or wrongly-pointed) compliance contract returning
    // `true` through its normal success path — the exact failure mode an
    // RPC-exception-only check would never catch.
    Client.from.mockResolvedValueOnce({
      is_allowed: jest.fn().mockResolvedValue({ result: true }),
    });

    const result = await onchainCompliance.checkComplianceCanary();
    expect(result).toEqual({ configured: true, ok: false });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[compliance] CANARY BREACH'),
      expect.objectContaining({ canary: expect.any(String) }),
    );

    consoleErrorSpy.mockRestore();
  });
});
