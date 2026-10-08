import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { pool } from '../db/pool';
import { AuthService } from './auth.service';

// Hits the real konfirm_test Postgres database (see test/env.ts) — real
// bcrypt hashing, real unique-email constraint, real JWT signing. No mocks
// standing in for the one thing (a merchant's credentials) that actually
// matters to get right.
describe('AuthService (integration, real Postgres)', () => {
  const auth = new AuthService({ send: async () => undefined });
  const testEmails: string[] = [];

  function freshEmail(): string {
    const email = `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    testEmails.push(email);
    return email;
  }

  afterAll(async () => {
    if (testEmails.length > 0) {
      await pool.query('DELETE FROM merchants WHERE email = ANY($1)', [testEmails]);
    }
    await pool.end();
  });

  it('signs up a merchant and returns a usable token', async () => {
    const email = freshEmail();
    const { token, merchant } = await auth.signup(
      email,
      'correct-horse-battery-staple',
      'Test Merchant',
      'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB',
    );

    expect(merchant.email).toBe(email);
    expect(merchant.name).toBe('Test Merchant');
    expect(token).toEqual(expect.any(String));

    const claims = auth.verifyToken(token);
    expect(claims.email).toBe(email);
    expect(claims.id).toBe(merchant.id);
  });

  it('rejects a second signup with the same email', async () => {
    const email = freshEmail();
    await auth.signup(email, 'first-password-123', 'First', 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB');

    await expect(
      auth.signup(email, 'different-password-456', 'Second', 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB'),
    ).rejects.toThrow(ConflictException);
  });

  it('logs in with the correct password', async () => {
    const email = freshEmail();
    await auth.signup(email, 'a-real-password-789', 'Login Test', 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB');

    const { merchant } = await auth.login(email, 'a-real-password-789');
    expect(merchant.email).toBe(email);
  });

  it('rejects the wrong password with the generic message', async () => {
    const email = freshEmail();
    await auth.signup(email, 'the-real-password', 'Wrong Pw Test', 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB');

    await expect(auth.login(email, 'not-the-real-password')).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a nonexistent email with the exact same message as a wrong password — no account enumeration', async () => {
    let wrongPasswordMessage = '';
    let nonexistentEmailMessage = '';

    const email = freshEmail();
    await auth.signup(email, 'some-password-here', 'Enum Test', 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB');

    try {
      await auth.login(email, 'wrong-password');
    } catch (err) {
      wrongPasswordMessage = (err as UnauthorizedException).message;
    }

    try {
      await auth.login('definitely-not-registered@example.com', 'anything');
    } catch (err) {
      nonexistentEmailMessage = (err as UnauthorizedException).message;
    }

    expect(wrongPasswordMessage).not.toBe('');
    expect(wrongPasswordMessage).toBe(nonexistentEmailMessage);
  });

  it('rejects login for a suspended merchant even with the correct password', async () => {
    const email = freshEmail();
    await auth.signup(email, 'a-fine-password-000', 'Suspend Test', 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB');
    await pool.query("UPDATE merchants SET status = 'suspended' WHERE email = $1", [email]);

    await expect(auth.login(email, 'a-fine-password-000')).rejects.toThrow(ForbiddenException);
  });
});
