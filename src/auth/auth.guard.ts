import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { pool } from '../db/pool';
import { AuthService, MerchantClaims } from './auth.service';

export interface AuthedRequest extends Request {
  merchant: MerchantClaims;
}

const COOKIE_NAME = 'konfirm_session';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) throw new UnauthorizedException('log in to continue');
    const claims = this.auth.verifyToken(token);

    // A suspended merchant's already-issued sessions must stop working
    // immediately, not just future logins — an admin suspending an account
    // is meant to be an instant, not something the merchant only discovers
    // next time their 30-day cookie happens to expire. One extra indexed
    // PK lookup per authenticated request, in exchange for that.
    //
    // The same lookup checks session_version. A password reset bumps it, so
    // every session issued before the reset (including a stolen one) stops
    // working at once.
    const { rows } = await pool.query('SELECT status, session_version FROM merchants WHERE id = $1', [claims.id]);
    if (rows[0]?.status === 'suspended') {
      throw new UnauthorizedException('this account has been suspended — contact support');
    }
    if (!rows[0] || rows[0].session_version !== (claims.sv ?? 0)) {
      throw new UnauthorizedException('session expired or invalid — please log in again');
    }

    // Strip the internal session version so it never reaches a response body.
    const { sv: _sv, ...merchant } = claims;
    req.merchant = merchant;
    return true;
  }
}

export const SESSION_COOKIE = COOKIE_NAME;
