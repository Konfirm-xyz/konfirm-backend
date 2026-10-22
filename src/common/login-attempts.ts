import { HttpException, HttpStatus } from '@nestjs/common';

// Per-account cap on failed logins, on top of the per-IP throttle on the
// login routes. The IP throttle alone lets someone with a pool of addresses
// spread guesses against one account and never trip it; this counts by
// account instead, so the total is capped however many IPs are used.
//
// Rolling window, not a permanent lock: once the oldest failure ages out of
// the window the account accepts attempts again, and a success clears the
// count. A real user who mistypes a few times never hits it; someone
// deliberately locking out a known account can only hold it for one window
// at a time.
//
// Unknown emails are counted the same way as real ones, so a 429 here says
// nothing about whether an account exists.
//
// In memory, which matches the single-process deployment (the API and the
// cron jobs share one process). A restart forgets the counts.
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60_000;
// Bounds memory if someone sprays random emails.
const MAX_TRACKED_ACCOUNTS = 10_000;

export class LoginAttemptLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = LOGIN_MAX_FAILURES,
    private readonly windowMs = LOGIN_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  // Call before checking the password, so a locked account doesn't keep
  // giving an attacker answers.
  assertNotLocked(account: string): void {
    if (this.recent(account).length >= this.maxFailures) {
      throw new HttpException(
        'too many failed login attempts for this account — try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordFailure(account: string): void {
    const recent = this.recent(account);
    recent.push(this.now());
    this.failures.delete(account);
    this.failures.set(account, recent);
    if (this.failures.size > MAX_TRACKED_ACCOUNTS) this.prune();
  }

  recordSuccess(account: string): void {
    this.failures.delete(account);
  }

  clear(): void {
    this.failures.clear();
  }

  private recent(account: string): number[] {
    const cutoff = this.now() - this.windowMs;
    return (this.failures.get(account) ?? []).filter((t) => t > cutoff);
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [account, times] of this.failures) {
      if (times[times.length - 1] <= cutoff) this.failures.delete(account);
    }
    // Still over after dropping expired entries: drop the least recently
    // failed accounts (Map keeps insertion order, and recordFailure
    // re-inserts on every failure).
    for (const account of this.failures.keys()) {
      if (this.failures.size <= MAX_TRACKED_ACCOUNTS) break;
      this.failures.delete(account);
    }
  }
}

// One per login surface, so a merchant and an admin sharing an email don't
// share a counter.
export const merchantLoginAttempts = new LoginAttemptLimiter();
export const adminLoginAttempts = new LoginAttemptLimiter();
