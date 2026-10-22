import { HttpStatus } from '@nestjs/common';
import { LoginAttemptLimiter } from './login-attempts';

describe('LoginAttemptLimiter', () => {
  let now: number;
  let limiter: LoginAttemptLimiter;

  beforeEach(() => {
    now = 1_000_000;
    limiter = new LoginAttemptLimiter(3, 60_000, () => now);
  });

  const statusOf = (fn: () => void): number | null => {
    try {
      fn();
      return null;
    } catch (err) {
      return (err as { getStatus(): number }).getStatus();
    }
  };

  it('locks an account after the max failures, with 429', () => {
    for (let i = 0; i < 3; i++) {
      expect(statusOf(() => limiter.assertNotLocked('a@example.com'))).toBeNull();
      limiter.recordFailure('a@example.com');
    }
    expect(statusOf(() => limiter.assertNotLocked('a@example.com'))).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('counts per account, not globally', () => {
    for (let i = 0; i < 3; i++) limiter.recordFailure('a@example.com');
    expect(statusOf(() => limiter.assertNotLocked('b@example.com'))).toBeNull();
  });

  it('unlocks once failures age out of the window', () => {
    for (let i = 0; i < 3; i++) limiter.recordFailure('a@example.com');
    now += 60_001;
    expect(statusOf(() => limiter.assertNotLocked('a@example.com'))).toBeNull();
  });

  it('clears the count on a successful login', () => {
    for (let i = 0; i < 2; i++) limiter.recordFailure('a@example.com');
    limiter.recordSuccess('a@example.com');
    limiter.recordFailure('a@example.com');
    expect(statusOf(() => limiter.assertNotLocked('a@example.com'))).toBeNull();
  });
});
