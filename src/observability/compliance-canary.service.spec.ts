import { checkComplianceCanary } from '../common/onchain-compliance';
import { captureException } from './sentry';
import { ComplianceCanaryService } from './compliance-canary.service';

jest.mock('../common/onchain-compliance', () => ({
  ...jest.requireActual('../common/onchain-compliance'),
  checkComplianceCanary: jest.fn(),
}));
jest.mock('./sentry', () => ({ captureException: jest.fn() }));

describe('ComplianceCanaryService', () => {
  const svc = new ComplianceCanaryService();
  const canary = checkComplianceCanary as jest.MockedFunction<typeof checkComplianceCanary>;
  const capture = captureException as jest.MockedFunction<typeof captureException>;
  const errors: string[] = [];
  const realError = (svc as unknown as { logger: { error: (m: string) => void } }).logger.error;

  beforeEach(() => {
    errors.length = 0;
    canary.mockReset();
    capture.mockReset();
    (svc as unknown as { logger: { error: (m: string) => void } }).logger.error = (m: string) => void errors.push(m);
  });
  afterEach(() => {
    (svc as unknown as { logger: { error: (m: string) => void } }).logger.error = realError;
  });

  it('calls checkComplianceCanary on the scheduled tick', async () => {
    canary.mockResolvedValue({ configured: true, ok: true });

    const result = await svc.check();

    expect(canary).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ configured: true, ok: true });
    expect(capture).not.toHaveBeenCalled();
  });

  it('escalates a breach (ok === false) to Sentry', async () => {
    canary.mockResolvedValue({ configured: true, ok: false });

    const result = await svc.check();

    expect(result).toEqual({ configured: true, ok: false });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(errors.some((m) => m.includes('CANARY BREACH') || m.includes('canary breach'))).toBe(true);
  });

  it('does not escalate when the canary is not configured', async () => {
    canary.mockResolvedValue({ configured: false, ok: null });

    await svc.check();

    expect(capture).not.toHaveBeenCalled();
  });

  it('escalates a thrown check failure instead of rejecting the cron tick', async () => {
    canary.mockRejectedValue(new Error('rpc down'));

    const result = await svc.check();

    expect(result).toEqual({ configured: false, ok: null });
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
