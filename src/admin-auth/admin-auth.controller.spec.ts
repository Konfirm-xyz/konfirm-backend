import type { Request, Response } from 'express';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { ADMIN_SESSION_COOKIE, AuthedAdminRequest } from './admin-auth.guard';

// Unit test: the controller's request/response wiring, service mocked out.
describe('AdminAuthController (unit)', () => {
  const admin = { id: 'a1', email: 'a@example.com', name: 'A', role: 'superadmin' };
  const originalEnv = process.env.NODE_ENV;
  let service: { login: jest.Mock; logout: jest.Mock; changePassword: jest.Mock };
  let res: { cookie: jest.Mock; clearCookie: jest.Mock };
  let controller: AdminAuthController;

  const expectedCookie = (secure: boolean) => ({
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: 12 * 60 * 60 * 1000,
  });

  beforeEach(() => {
    service = {
      login: jest.fn().mockResolvedValue({ token: 'tok', admin }),
      logout: jest.fn().mockResolvedValue(undefined),
      changePassword: jest.fn().mockResolvedValue({ token: 'tok2', admin }),
    };
    res = { cookie: jest.fn(), clearCookie: jest.fn() };
    controller = new AdminAuthController(service as unknown as AdminAuthService);
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('login sets a strict, httpOnly session cookie and returns the admin', async () => {
    process.env.NODE_ENV = 'test';
    const out = await controller.login({ email: 'a@example.com', password: 'pw' }, res as unknown as Response);
    expect(service.login).toHaveBeenCalledWith('a@example.com', 'pw');
    expect(res.cookie).toHaveBeenCalledWith(ADMIN_SESSION_COOKIE, 'tok', expectedCookie(false));
    expect(out).toEqual({ admin });
  });

  it('marks the cookie secure in production', async () => {
    process.env.NODE_ENV = 'production';
    await controller.login({ email: 'a@example.com', password: 'pw' }, res as unknown as Response);
    expect(res.cookie).toHaveBeenCalledWith(ADMIN_SESSION_COOKIE, 'tok', expectedCookie(true));
  });

  it('logout revokes server-side and clears the cookie', async () => {
    const req = { cookies: { [ADMIN_SESSION_COOKIE]: 'tok' } } as unknown as Request;
    const out = await controller.logout(req, res as unknown as Response);
    expect(service.logout).toHaveBeenCalledWith('tok');
    expect(res.clearCookie).toHaveBeenCalledWith(ADMIN_SESSION_COOKIE);
    expect(out).toEqual({ ok: true });
  });

  it('me returns req.admin', () => {
    expect(controller.me({ admin } as unknown as AuthedAdminRequest)).toEqual({ admin });
  });

  it('change-password re-issues the session cookie', async () => {
    process.env.NODE_ENV = 'test';
    const req = { admin } as unknown as AuthedAdminRequest;
    const out = await controller.changePassword(
      req,
      { current_password: 'old', new_password: 'new-password' },
      res as unknown as Response,
    );
    expect(service.changePassword).toHaveBeenCalledWith('a1', 'old', 'new-password');
    expect(res.cookie).toHaveBeenCalledWith(ADMIN_SESSION_COOKIE, 'tok2', expectedCookie(false));
    expect(out).toEqual({ admin });
  });
});
