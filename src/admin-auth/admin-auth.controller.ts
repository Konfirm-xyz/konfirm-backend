import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AdminAuthService } from './admin-auth.service';
import { AdminGuard, ADMIN_SESSION_COOKIE, AuthedAdminRequest } from './admin-auth.guard';
import { zodBody } from '../common/zod-to-openapi';

// Same 10/min rationale as auth.controller.ts's AUTH_THROTTLE.
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

// Same bcrypt 72-byte cap as auth.controller.ts's passwordSchema.
const passwordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'password must be 72 bytes or fewer');

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: passwordSchema,
});

const COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// Deliberately no POST /admin/auth/signup — an internet-facing "create an
// admin account" endpoint is its own security problem. Admins are
// provisioned out-of-band via `npm run seed:admin` (see db/seed-admin.ts).
@ApiTags('Admin Auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Admin login',
    description:
      'Completely separate from merchant auth — different table, different JWT secret, different cookie, 12-hour expiry. ' +
      'No /admin/auth/signup exists by design. Rate-limited to 10 req/min per IP.',
  })
  @ApiBody(zodBody(loginSchema, 'Admin login request'))
  @ApiResponse({ status: 200, description: 'Admin logged in. konfirm_admin_session cookie set (SameSite=Strict, 12h).' })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, admin } = await this.adminAuth.login(body.email, body.password);
    this.setSessionCookie(res, token);
    return { admin };
  }

  // Revokes server-side as well as clearing the cookie — see auth.controller.ts.
  @Post('logout')
  @HttpCode(200)
  @ApiCookieAuth('admin-session')
  @ApiOperation({
    summary: 'Admin logout',
    description: "Revokes all of the admin's sessions server-side (bumps session_version) and clears the cookie.",
  })
  @ApiResponse({ status: 200, description: 'Returns { ok: true }.' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.adminAuth.logout(req.cookies?.[ADMIN_SESSION_COOKIE]);
    res.clearCookie(ADMIN_SESSION_COOKIE);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AdminGuard)
  @ApiCookieAuth('admin-session')
  @ApiOperation({ summary: 'Get current admin', description: "Returns the authenticated admin's profile from their session claims." })
  @ApiResponse({ status: 200, description: 'Current admin object.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  me(@Req() req: AuthedAdminRequest) {
    return { admin: req.admin };
  }

  // No forgot-password flow for admins yet: this covers rotating a password
  // that may have been phished, for an admin who can still log in.
  @Post('change-password')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @Throttle(AUTH_THROTTLE)
  @ApiCookieAuth('admin-session')
  @ApiOperation({
    summary: 'Change own admin password',
    description:
      'Requires the current password. Signs out every other session for this admin (bumps session_version) and ' +
      'issues a fresh cookie for this one. Logged to admin_actions. Rate-limited to 10 req/min per IP.',
  })
  @ApiBody(zodBody(changePasswordSchema, 'Admin change password request'))
  @ApiResponse({ status: 200, description: 'Password changed. A new konfirm_admin_session cookie is set.' })
  @ApiResponse({ status: 400, description: 'Current password is incorrect, or the new password is invalid or unchanged.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async changePassword(
    @Req() req: AuthedAdminRequest,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, admin } = await this.adminAuth.changePassword(req.admin.id, body.current_password, body.new_password);
    this.setSessionCookie(res, token);
    return { admin };
  }

  private setSessionCookie(res: Response, token: string) {
    res.cookie(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      // Stricter than the merchant cookie's 'lax' — this guards mutation of
      // other people's accounts, not just the admin's own session.
      sameSite: 'strict',
      // Same NODE_ENV-driven reasoning as the merchant cookie — see
      // auth.controller.ts's setSessionCookie.
      secure: process.env.NODE_ENV === 'production',
      maxAge: COOKIE_MAX_AGE_MS,
    });
  }
}
