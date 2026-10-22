import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { assertDistinctSecrets, resolveSessionSecret } from '../common/secrets';
import { MAILER, Mailer } from '../mail/mailer';

// Production refuses to start without a real secret — see common/secrets.ts.
const JWT_SECRET = resolveSessionSecret('JWT_SECRET', 'dev-only-insecure-secret-change-me');
assertDistinctSecrets(JWT_SECRET, resolveSessionSecret('ADMIN_JWT_SECRET', 'dev-only-insecure-admin-secret-change-me', process.env, () => undefined), ['JWT_SECRET', 'ADMIN_JWT_SECRET']);
const TOKEN_TTL = '30d';

// Reset links are short-lived and single-use. Only a hash is stored.
const RESET_TTL_MINUTES = 30;

// Email-verification links are longer-lived than password resets — a new
// merchant may not check their inbox immediately — but still single-use.
const VERIFY_TTL_MINUTES = 24 * 60;

// Compared against when an email has no account, so a login for an unknown
// address takes as long as one for a real account. Otherwise the timing
// reveals which emails are registered.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', 10);

// Emails are stored lowercase (see migration 021). Trimming and lowercasing
// on every entry point means "Alice@x.com" finds the same account.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// A referred merchant's onboarding trial — removes the biggest friction
// point in trying a new payment processor (paying real fees before you
// know it's worth it), capped both ways so it stays a trial, not a
// permanent discount: 30 days OR $500 processed, whichever comes first.
// See effective_fee_bps() in reconciler/src/store.rs for how this is
// actually applied per-payment.
const REFERRAL_TRIAL_FEE_BPS = 0;
const REFERRAL_TRIAL_DAYS = 30;
const REFERRAL_TRIAL_VOLUME_CAP_USDC = 500;

export interface MerchantClaims {
  id: string;
  email: string;
  name: string;
  stellar_base_address: string | null;
  // Bumped on password reset. Tokens issued before a reset stop working.
  sv?: number;
  // Set for team-member sessions (merchant_members row).
  // When present, id is still the merchant_id (so all downstream queries
  // that filter by merchant_id continue to work unchanged), and member_id
  // is the merchant_members.id used by AuthGuard to verify session_version.
  member_id?: string;
  // 'owner' for direct merchant logins; 'owner' or 'staff' for member logins.
  role?: 'owner' | 'staff';
}

// Excludes 0/O/1/I — ambiguous when read aloud or typed from memory, which
// is exactly how a referral code gets shared in practice.
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_LENGTH = 8;

function randomReferralCode(): string {
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += REFERRAL_CODE_ALPHABET[Math.floor(Math.random() * REFERRAL_CODE_ALPHABET.length)];
  }
  return code;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(@Inject(MAILER) private readonly mailer: Mailer) {}

  async signup(
    email: string,
    password: string,
    name: string,
    stellarBaseAddress: string,
    referralCode?: string,
  ): Promise<{ token: string; merchant: MerchantClaims; status: string }> {
    email = normalizeEmail(email);
    const existing = await pool.query('SELECT id FROM merchants WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      throw new ConflictException('an account with this email already exists');
    }

    // An invalid/mistyped referral code should never block signup — it's a
    // growth mechanism, not a security gate. Looked up before the INSERT so
    // a bad code costs nothing (no wasted account row) if it doesn't exist.
    //
    // Self-referral guard: if the referrer's stellar_base_address matches
    // the address being signed up with, we treat the code as if it didn't
    // exist.  This is the primary correlation signal available at signup
    // time — the same Stellar address can't operate two independent
    // businesses, so a match is conclusive evidence that both accounts are
    // controlled by the same party.  We drop the code silently rather than
    // rejecting signup: an attacker learns nothing useful (the code "worked"
    // from their perspective — they just don't earn a reward from it), and
    // a legitimate merchant who accidentally typed their own code isn't
    // hard-blocked from creating an account.
    let referrerId: string | null = null;
    if (referralCode) {
      const referrer = await pool.query(
        'SELECT id, stellar_base_address FROM merchants WHERE referral_code = $1',
        [referralCode.toUpperCase()],
      );
      const referrerRow = referrer.rows[0];
      if (referrerRow) {
        const sameAddress =
          stellarBaseAddress &&
          referrerRow.stellar_base_address &&
          referrerRow.stellar_base_address === stellarBaseAddress;
        if (sameAddress) {
          this.logger.warn(
            `self-referral attempt blocked at signup: address ${stellarBaseAddress} used code belonging to merchant ${referrerRow.id}`,
          );
        } else {
          referrerId = referrerRow.id;
        }
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const ownCode = await this.generateUniqueReferralCode();
    // Trial fields stay NULL for a non-referred signup — effective_fee_bps()
    // treats a NULL promo_fee_bps as "no promo, use the base rate", so
    // there's no separate "no discount" branch to keep in sync here.
    const promoFeeBps = referrerId ? REFERRAL_TRIAL_FEE_BPS : null;
    const promoExpiresAt = referrerId ? new Date(Date.now() + REFERRAL_TRIAL_DAYS * 24 * 60 * 60 * 1000) : null;
    const promoVolumeCap = referrerId ? REFERRAL_TRIAL_VOLUME_CAP_USDC : null;
    // New accounts start 'pending' until the email address is confirmed —
    // see confirmEmail(). The schema default is 'pending' too, but we set it
    // explicitly so the intent is clear at the call site.
    const { rows } = await pool.query(
      `INSERT INTO merchants
        (email, password_hash, name, stellar_base_address, status, referral_code,
         promo_fee_bps, promo_expires_at, promo_volume_cap_usdc)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
       RETURNING id, email, name, stellar_base_address, status`,
      [email, passwordHash, name, stellarBaseAddress, ownCode, promoFeeBps, promoExpiresAt, promoVolumeCap],
    );
    const merchant = rows[0] as MerchantClaims;

    if (referrerId) {
      await pool.query('INSERT INTO referrals (referrer_id, referred_id, code) VALUES ($1, $2, $3)', [
        referrerId,
        merchant.id,
        referralCode!.toUpperCase(),
      ]);
    }

    // Issue the verification token and email it. A failure to send must not
    // roll back the account — the merchant can request a resend — so this is
    // best-effort and logged rather than thrown.
    try {
      const verifyToken = await this.createEmailVerificationToken(merchant.id);
      await this.mailer.sendEmailVerification(merchant.email, verifyToken);
    } catch (err) {
      this.logger.error(`failed to send verification email for merchant ${merchant.id}: ${(err as Error).message}`);
    }

    return { token: this.issueToken(merchant, 0), merchant, status: 'pending' };
  }

  // Mirrors the password-reset token pattern (migration 021): a random
  // opaque token is emailed, only its SHA-256 hash is stored, and it is
  // single-use with a TTL. Reuses the account_recovery_tokens table shape.
  private async createEmailVerificationToken(merchantId: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + VERIFY_TTL_MINUTES * 60 * 1000);
    await pool.query(
      `INSERT INTO account_recovery_tokens (merchant_id, token_hash, purpose, expires_at)
       VALUES ($1, $2, 'email_verification', $3)`,
      [merchantId, tokenHash, expiresAt],
    );
    return token;
  }

  // Validates a verification token and flips the merchant from 'pending' to
  // 'active'. Idempotent for an already-active account so a double-click on
  // the confirmation link doesn't error.
  async confirmEmail(token: string): Promise<{ status: string }> {
    if (!token) throw new BadRequestException('missing verification token');
    const tokenHash = sha256(token);
    const { rows } = await pool.query(
      `SELECT id, merchant_id, expires_at, used_at
         FROM account_recovery_tokens
        WHERE token_hash = $1 AND purpose = 'email_verification'`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) throw new BadRequestException('invalid or expired verification token');
    if (row.used_at) throw new BadRequestException('verification token already used');
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new BadRequestException('verification token expired');
    }

    await pool.query('UPDATE account_recovery_tokens SET used_at = now() WHERE id = $1', [row.id]);
    await pool.query(
      `UPDATE merchants SET status = 'active' WHERE id = $1 AND status = 'pending'`,
      [row.merchant_id],
    );
    return { status: 'active' };
  }

  // Astronomically unlikely to collide at this alphabet/length (32^8), but
  // a signup is exactly the wrong place to let an unhandled unique-
  // constraint violation surface as a raw 500, so this checks first rather
  // than trusting probability alone.
  private async generateUniqueReferralCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomReferralCode();
      const { rows } = await pool.query('SELECT 1 FROM merchants WHERE referral_code = $1', [code]);
      if (rows.length === 0) return code;
    }
    throw new Error('could not generate a unique referral code after 5 attempts');
  }

  async login(email: string, password: string): Promise<{ token: string; merchant: MerchantClaims }> {
    const { rows } = await pool.query(
      'SELECT id, email, name, stellar_base_address, password_hash, status, session_version FROM merchants WHERE email = $1',
      [normalizeEmail(email)],
    );
    // Same generic error whether the email doesn't exist or the password is
    // wrong — telling them apart lets an attacker enumerate real accounts.
    const invalid = () => new UnauthorizedException('invalid email or password');
    if (rows.length === 0) {
      // Do the same bcrypt work as for a real account, so timing doesn't
      // reveal which emails are registered.
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      throw invalid();
    }

    const row = rows[0];
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) throw invalid();

    // A distinct message is fine here, unlike above — a correct password
    // already confirms the account exists, so this isn't an enumeration risk.
    if (row.status === 'suspended') {
      throw new ForbiddenException('this account has been suspended — contact support');
    }

    const merchant: MerchantClaims = {
      id: row.id,
      email: row.email,
      name: row.name,
      stellar_base_address: row.stellar_base_address,
    };
    return { token: this.issueToken(merchant, row.session_version), merchant };
  }

  // Sends a reset link if the email belongs to an active account. Callers
  // must return the same response either way: this method says nothing to
  // the caller about whether an account exists.
  async requestPasswordReset(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const { rows } = await pool.query(`SELECT id FROM merchants WHERE email = $1 AND status = 'active'`, [email]);
    if (rows.length === 0) return;
    const merchantId = rows[0].id;

    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    if (process.env.NODE_ENV === 'production' && !process.env.APP_URL) {
      throw new Error('APP_URL must be set in production to build reset links');
    }

    // Only one live link at a time: a new request invalidates older ones.
    await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE merchant_id = $1 AND used_at IS NULL', [merchantId]);

    const token = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO password_reset_tokens (merchant_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 minute'))`,
      [merchantId, sha256(token), RESET_TTL_MINUTES],
    );

    await this.mailer.send({
      to: email,
      subject: 'Reset your Konfirm password',
      text:
        `Use this link to choose a new password:\n\n${appUrl}/reset-password?token=${token}\n\n` +
        `The link expires in ${RESET_TTL_MINUTES} minutes and works once. ` +
        `If you didn't ask for this, ignore this email; your password hasn't changed.`,
    });
  }

  // Single-use: the token is consumed by the same UPDATE that checks it, so
  // two concurrent submissions can't both succeed. A successful reset bumps
  // session_version, which signs out every existing session.
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const { rows } = await pool.query(
      `UPDATE password_reset_tokens SET used_at = NOW()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING merchant_id`,
      [sha256(token)],
    );
    if (rows.length === 0) {
      throw new BadRequestException('this reset link is invalid or has expired — request a new one');
    }
    const merchantId = rows[0].merchant_id;
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE merchants SET password_hash = $2, session_version = session_version + 1, updated_at = NOW() WHERE id = $1`,
      [merchantId, passwordHash],
    );
    await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE merchant_id = $1 AND used_at IS NULL', [merchantId]);
    this.logger.log(`password reset completed for merchant ${merchantId}`);
  }

  // Bumps session_version the same way a password reset does, so the token
  // being logged out (and any copy of it) stops passing AuthGuard. A missing
  // or already-invalid token has nothing to revoke, so it's a no-op.
  // Member sessions (member_id present) bump merchant_members.session_version;
  // owner sessions bump merchants.session_version.
  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    let claims: MerchantClaims;
    try {
      claims = this.verifyToken(token);
    } catch {
      return;
    }
    if (claims.member_id) {
      await pool.query(
        'UPDATE merchant_members SET session_version = session_version + 1 WHERE id = $1',
        [claims.member_id],
      );
    } else {
      await pool.query('UPDATE merchants SET session_version = session_version + 1 WHERE id = $1', [claims.id]);
    }
  }

  // "Activated" is computed here (EXISTS a paid payment), not stored — see
  // migration 014's comment for why that's deliberate.
  async myReferrals(merchantId: string): Promise<{
    code: string | null;
    promo: { active: boolean; feeBps: number | null; expiresAt: string | null; volumeCapUsdc: string | null; volumeSoFarUsdc: string } | null;
    referrals: unknown[];
  }> {
    // Same "active" definition the reconciler's effective_fee_bps() uses
    // (time valid, and under the volume cap if one is set) -- computed
    // here purely for display, so a merchant can actually see the
    // discount that's silently applying to their payments rather than
    // discovering it only by noticing a smaller-than-expected fee.
    const { rows } = await pool.query(
      `SELECT
         referral_code,
         promo_fee_bps,
         promo_expires_at,
         promo_volume_cap_usdc,
         COALESCE((SELECT SUM(amount_usdc) FROM payments WHERE merchant_id = $1 AND status = 'paid'), 0) AS volume_so_far_usdc,
         (promo_fee_bps IS NOT NULL
           AND promo_expires_at > NOW()
           AND (promo_volume_cap_usdc IS NULL
                OR promo_volume_cap_usdc > COALESCE((SELECT SUM(amount_usdc) FROM payments WHERE merchant_id = $1 AND status = 'paid'), 0))
         ) AS promo_active
       FROM merchants WHERE id = $1`,
      [merchantId],
    );
    const row = rows[0];

    const { rows: referrals } = await pool.query(
      `SELECT m.name, m.email, r.created_at,
              EXISTS(SELECT 1 FROM payments p WHERE p.merchant_id = r.referred_id AND p.status = 'paid') AS activated
       FROM referrals r
       JOIN merchants m ON m.id = r.referred_id
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC`,
      [merchantId],
    );

    return {
      code: row?.referral_code ?? null,
      promo: row?.promo_fee_bps === null
        ? null
        : {
            active: row.promo_active,
            feeBps: row.promo_fee_bps,
            expiresAt: row.promo_expires_at,
            volumeCapUsdc: row.promo_volume_cap_usdc,
            volumeSoFarUsdc: row.volume_so_far_usdc,
          },
      referrals,
    };
  }

  // ---- Profile update methods (issue #38) ----

  // Name changes are low-risk: no re-auth required.  The JWT is re-issued so
  // the client's in-memory claims stay in sync without a full logout/login.
  async updateName(
    merchantId: string,
    newName: string,
  ): Promise<{ token: string; merchant: MerchantClaims }> {
    const { rows } = await pool.query(
      `UPDATE merchants SET name = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, stellar_base_address, session_version`,
      [merchantId, newName],
    );
    if (rows.length === 0) throw new NotFoundException('merchant not found');
    const row = rows[0];
    const merchant: MerchantClaims = {
      id: row.id,
      email: row.email,
      name: row.name,
      stellar_base_address: row.stellar_base_address,
    };
    return { token: this.issueToken(merchant, row.session_version), merchant };
  }

  // Sends a verification token to the *new* address.  The actual email swap
  // doesn't happen until confirmEmailChange() is called.  Sending to the new
  // address (not the old one) confirms control of the destination before
  // routing any future correspondence there.
  //
  // A new request while a pending one is open replaces it via
  // DELETE+INSERT so only one live token exists per merchant at a time.
  async requestEmailChange(merchantId: string, newEmail: string): Promise<void> {
    newEmail = normalizeEmail(newEmail);

    // Reject if the new address is already taken by another merchant.
    const { rows: conflict } = await pool.query(
      'SELECT id FROM merchants WHERE email = $1 AND id <> $2',
      [newEmail, merchantId],
    );
    if (conflict.length > 0) {
      throw new ConflictException('an account with this email already exists');
    }

    // Reject if the new address is the same as the current one.
    const { rows: current } = await pool.query('SELECT email FROM merchants WHERE id = $1', [merchantId]);
    if (current.length === 0) throw new NotFoundException('merchant not found');
    if (current[0].email === newEmail) {
      throw new BadRequestException('new email must differ from the current email');
    }

    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    if (process.env.NODE_ENV === 'production' && !process.env.APP_URL) {
      throw new Error('APP_URL must be set in production to build email-change links');
    }

    // Replace any existing pending request for this merchant.
    await pool.query(
      'DELETE FROM email_change_tokens WHERE merchant_id = $1',
      [merchantId],
    );

    const token = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO email_change_tokens (merchant_id, token_hash, pending_email, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')`,
      [merchantId, sha256(token), newEmail],
    );

    await this.mailer.send({
      to: newEmail,
      subject: 'Confirm your new Konfirm email address',
      text:
        `You requested a Konfirm email change.  Confirm your new address by visiting:\n\n` +
        `${appUrl}/confirm-email?token=${token}\n\n` +
        `This link expires in 30 minutes and works once.  ` +
        `Your current email is unchanged until you click it.  ` +
        `If you didn't request this, you can ignore this email safely.`,
    });
  }

  // Consumes the token, atomically swaps the email, and re-issues the JWT so
  // the client's claims reflect the new address without requiring a re-login.
  // Bumps session_version to sign out every other session — a leftover session
  // issued under the old email would otherwise present stale identity.
  async confirmEmailChange(
    token: string,
  ): Promise<{ token: string; merchant: MerchantClaims }> {
    // Consume the token atomically — two concurrent submissions can't both win.
    const { rows: tokenRows } = await pool.query(
      `UPDATE email_change_tokens SET used_at = NOW()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING merchant_id, pending_email`,
      [sha256(token)],
    );
    if (tokenRows.length === 0) {
      throw new BadRequestException('this confirmation link is invalid or has expired — request a new one');
    }
    const { merchant_id: merchantId, pending_email: newEmail } = tokenRows[0];

    // Double-check the target address is still free (another merchant could
    // have signed up with it during the 30-minute window).
    const { rows: conflict } = await pool.query(
      'SELECT id FROM merchants WHERE email = $1 AND id <> $2',
      [newEmail, merchantId],
    );
    if (conflict.length > 0) {
      throw new ConflictException(
        'this email address is now taken — please start the change process again',
      );
    }

    const { rows } = await pool.query(
      `UPDATE merchants
       SET email = $2, session_version = session_version + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, stellar_base_address, session_version`,
      [merchantId, newEmail],
    );
    if (rows.length === 0) throw new NotFoundException('merchant not found');
    const row = rows[0];
    const merchant: MerchantClaims = {
      id: row.id,
      email: row.email,
      name: row.name,
      stellar_base_address: row.stellar_base_address,
    };
    this.logger.log(`email changed for merchant ${merchantId} → ${newEmail}`);
    return { token: this.issueToken(merchant, row.session_version), merchant };
  }

  // Stellar address changes are high-value (all future payments follow this
  // field), so they require the merchant to re-supply their password.  The JWT
  // is re-issued so the client's stellar_base_address claim is immediately
  // correct.
  async updateStellarAddress(
    merchantId: string,
    currentPassword: string,
    newAddress: string,
  ): Promise<{ token: string; merchant: MerchantClaims }> {
    const { rows } = await pool.query(
      'SELECT password_hash, session_version FROM merchants WHERE id = $1',
      [merchantId],
    );
    if (rows.length === 0) throw new NotFoundException('merchant not found');

    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) {
      throw new UnauthorizedException('current password is incorrect');
    }

    const { rows: updated } = await pool.query(
      `UPDATE merchants SET stellar_base_address = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, stellar_base_address, session_version`,
      [merchantId, newAddress],
    );
    const row = updated[0];
    const merchant: MerchantClaims = {
      id: row.id,
      email: row.email,
      name: row.name,
      stellar_base_address: row.stellar_base_address,
    };
    this.logger.log(`stellar_base_address updated for merchant ${merchantId}`);
    return { token: this.issueToken(merchant, row.session_version), merchant };
  }

  verifyToken(token: string): MerchantClaims {
    try {
      return jwt.verify(token, JWT_SECRET) as unknown as MerchantClaims;
    } catch {
      throw new UnauthorizedException('session expired or invalid — please log in again');
    }
  }

  private issueToken(merchant: MerchantClaims, sessionVersion: number): string {
    const payload: Record<string, unknown> = {
      id: merchant.id,
      email: merchant.email,
      name: merchant.name,
      stellar_base_address: merchant.stellar_base_address,
      sv: sessionVersion,
    };
    if (merchant.member_id) payload.member_id = merchant.member_id;
    if (merchant.role)      payload.role      = merchant.role;
    return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
  }
}
