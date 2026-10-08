import { AnchorClient } from './anchor-client';

// Mocked fetch: this is a unit test of the client's own logic (asset-code
// mapping, which error message belongs to which copy, what each call
// returns), not of the real anchor. fees.e2e-spec.ts and the deposits/
// withdrawals flows exercise the real anchor over the network.
describe('AnchorClient', () => {
  const endpoints = { webAuthUrl: 'https://anchor.example/auth', transferServerUrl: 'https://anchor.example/sep24' };
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  const jsonResponse = (status: number, body: unknown) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

  describe('deposit copy', () => {
    const client = new AnchorClient(endpoints, { partnerLabel: 'test-funds partner', actionNoun: 'deposit' });

    it('reaches the challenge endpoint with the account in the query string', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse(200, { transaction: 'xdr' }));
      await client.getChallenge('GABC');
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('account=GABC'), expect.anything());
    });

    it('uses the deposit-specific wording when the challenge call fails', async () => {
      fetchMock.mockReturnValue(jsonResponse(400, {}));
      await expect(client.getChallenge('GABC')).rejects.toThrow(/test-funds partner/);
    });

    it('maps XLM to the native asset code and hits the deposit path', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse(200, { id: '1', url: 'https://anchor.example/popup' }));
      await client.startInteractive('deposit', 'tok', 'XLM', 'GABC');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain('/transactions/deposit/interactive');
      expect(JSON.parse(init.body)).toEqual({ asset_code: 'native', account: 'GABC' });
    });

    it('passes a non-native currency code through unchanged', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse(200, {}));
      await client.startInteractive('deposit', 'tok', 'USDC', 'GABC');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ asset_code: 'USDC', account: 'GABC' });
    });

    it('reports the deposit-specific wording when starting fails', async () => {
      fetchMock.mockReturnValue(jsonResponse(400, {}));
      await expect(client.startInteractive('deposit', 'tok', 'USDC', 'GABC')).rejects.toThrow(/start a deposit/);
    });

    it('returns the transaction field from a status check', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse(200, { transaction: { status: 'pending' } }));
      await expect(client.getStatus('tok', '1')).resolves.toEqual({ status: 'pending' });
    });

    it('reports the deposit-specific wording when the status check fails', async () => {
      // A 4xx, not a 5xx: fetchWithRetry treats 5xx as retryable and throws its
      // own generic error before this client's own message ever runs — that's
      // existing, deliberate behaviour (src/common/retry.ts), not something
      // this test is about.
      fetchMock.mockReturnValue(jsonResponse(404, {}));
      await expect(client.getStatus('tok', '1')).rejects.toThrow(/deposit status/);
    });
  });

  describe('cash-out copy', () => {
    const client = new AnchorClient(endpoints, { partnerLabel: 'cash-out partner', actionNoun: 'cash-out' });

    it('uses the cash-out-specific wording and the withdraw path', async () => {
      fetchMock.mockReturnValue(jsonResponse(400, {}));
      await expect(client.getChallenge('GABC')).rejects.toThrow(/cash-out partner/);

      fetchMock.mockReturnValueOnce(jsonResponse(200, {}));
      await client.startInteractive('withdraw', 'tok', 'USDC', 'GABC');
      expect(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]).toContain('/transactions/withdraw/interactive');
    });

    it('prefers the anchor\'s own error message when one is given', async () => {
      fetchMock.mockReturnValue(jsonResponse(400, { error: 'KYC required' }));
      await expect(client.getChallenge('GABC')).rejects.toThrow('KYC required');
    });
  });
});
