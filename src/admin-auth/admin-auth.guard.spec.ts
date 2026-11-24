import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { pool } from '../db/pool';
import { AdminAuthService } from './admin-auth.service';
import { ADMIN_SESSION_COOKIE, AdminGuard } from './admin-auth.guard';

// Unit-level: AdminAuthService, Reflector and the DB read are stubbed so each
// canActivate branch is exercised in isolation (backend#329).
describe('AdminGuard', () => {
  const claims = { id: 'admin-1', email: 'a@example.com', name: 'A', role: 'superadmin', sv: 2 };
  let adminAuth: { verifyToken: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: AdminGuard;
  let querySpy: jest.SpyInstance;

  function ctx(cookies: Record<string, string> | undefined) {
    const req: Record<string, unknown> = { cookies };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
    return { req, context };
  }

  beforeEach(() => {
    adminAuth = { verifyToken: jest.fn().mockReturnValue({ ...claims }) };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    guard = new AdminGuard(adminAuth as unknown as AdminAuthService, reflector as unknown as Reflector);
    querySpy = jest.spyOn(pool, 'query').mockResolvedValue({ rows: [{ session_version: 2 }] } as never);
  });
  afterEach(() => querySpy.mockRestore());

  it('rejects a request with no session cookie', async () => {
    await expect(guard.canActivate(ctx(undefined).context)).rejects.toThrow(UnauthorizedException);
    expect(adminAuth.verifyToken).not.toHaveBeenCalled();
  });

  it('rejects a token whose session_version no longer matches', async () => {
    querySpy.mockResolvedValueOnce({ rows: [{ session_version: 3 }] } as never);
    await expect(guard.canActivate(ctx({ [ADMIN_SESSION_COOKIE]: 't' }).context)).rejects.toThrow(/session expired/);
  });

  it('rejects a token for an admin that no longer exists', async () => {
    querySpy.mockResolvedValueOnce({ rows: [] } as never);
    await expect(guard.canActivate(ctx({ [ADMIN_SESSION_COOKIE]: 't' }).context)).rejects.toThrow(/session expired/);
  });

  it('rejects an admin whose role is not in the allowed set', async () => {
    reflector.getAllAndOverride.mockReturnValue(['support']);
    await expect(guard.canActivate(ctx({ [ADMIN_SESSION_COOKIE]: 't' }).context)).rejects.toThrow(/role does not permit/);
  });

  it('admits a valid session, attaching claims without the session version', async () => {
    reflector.getAllAndOverride.mockReturnValue(['superadmin']);
    const { req, context } = ctx({ [ADMIN_SESSION_COOKIE]: 't' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(adminAuth.verifyToken).toHaveBeenCalledWith('t');
    const { sv: _sv, ...expected } = claims;
    expect(req.admin).toEqual(expected);
  });
});
