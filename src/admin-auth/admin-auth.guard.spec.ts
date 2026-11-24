import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { pool } from '../db/pool';
import { AdminAuthService } from './admin-auth.service';
import { AdminGuard, ADMIN_SESSION_COOKIE } from './admin-auth.guard';

// Unit test: the guard's canActivate branches in isolation, no HTTP round-trip.
describe('AdminGuard (unit)', () => {
  const claims = { id: 'a1', email: 'a@example.com', name: 'A', role: 'superadmin', sv: 2 };
  let verifyToken: jest.Mock;
  let getAllAndOverride: jest.Mock;
  let querySpy: jest.SpyInstance;
  let guard: AdminGuard;

  function ctx(cookies?: Record<string, string>) {
    const req: Record<string, unknown> = { cookies };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
    return { req, context };
  }

  beforeEach(() => {
    verifyToken = jest.fn().mockReturnValue(claims);
    getAllAndOverride = jest.fn().mockReturnValue(undefined);
    guard = new AdminGuard(
      { verifyToken } as unknown as AdminAuthService,
      { getAllAndOverride } as unknown as Reflector,
    );
    querySpy = jest.spyOn(pool, 'query').mockResolvedValue({ rows: [{ session_version: 2 }] } as never);
  });
  afterEach(() => querySpy.mockRestore());
  afterAll(async () => {
    await pool.end();
  });

  it('rejects a request with no session cookie', async () => {
    await expect(guard.canActivate(ctx().context)).rejects.toThrow(UnauthorizedException);
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('rejects when the admin no longer exists', async () => {
    querySpy.mockResolvedValueOnce({ rows: [] } as never);
    await expect(guard.canActivate(ctx({ [ADMIN_SESSION_COOKIE]: 't' }).context)).rejects.toThrow(/session expired/);
  });

  it('rejects a session_version mismatch', async () => {
    querySpy.mockResolvedValueOnce({ rows: [{ session_version: 3 }] } as never);
    await expect(guard.canActivate(ctx({ [ADMIN_SESSION_COOKIE]: 't' }).context)).rejects.toThrow(/session expired/);
  });

  it('rejects an admin whose role is not in the allowed set', async () => {
    getAllAndOverride.mockReturnValue(['support']);
    await expect(guard.canActivate(ctx({ [ADMIN_SESSION_COOKIE]: 't' }).context)).rejects.toThrow(/role does not permit/);
  });

  it('allows a valid session and strips sv from req.admin', async () => {
    getAllAndOverride.mockReturnValue(['superadmin']);
    const { req, context } = ctx({ [ADMIN_SESSION_COOKIE]: 't' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verifyToken).toHaveBeenCalledWith('t');
    expect(req.admin).toEqual({ id: 'a1', email: 'a@example.com', name: 'A', role: 'superadmin' });
  });
});
