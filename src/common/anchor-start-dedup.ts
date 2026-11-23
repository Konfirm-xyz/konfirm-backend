import { createHash } from 'crypto';
import { pool } from '../db/pool';
import { AnchorInteractiveSession } from './anchor-client';

// Server-side idempotency for starting a SEP-24 interactive session. The
// anchor mints a new transaction on every successful start, so two inbound
// requests for the same (direction, account, currency, token) must resolve
// to one anchor call. Same idea as x402.service.ts's idempotencyKey, plus an
// advisory lock (fees.service.ts's createSettlement pattern) so two
// *concurrent* requests serialize instead of both missing the lookup.
//
// The lock is a session-level advisory lock on a dedicated connection, not a
// transaction-scoped one: the anchor call is a real outbound HTTP request
// (up to its own 10s timeout), and holding a pooled connection plus an open
// transaction across it would starve the whole pool (default max 10) on a
// handful of concurrent starts. So the connection is released before
// `start()` runs and re-acquired only to record the result.
export function startIdempotencyKey(direction: string, account: string, currency: string, token: string): string {
  return createHash('sha256').update(JSON.stringify([direction, account, currency, token])).digest('hex');
}

async function findSession(key: string): Promise<AnchorInteractiveSession | undefined> {
  const { rows } = await pool.query<{ session: AnchorInteractiveSession }>(
    'SELECT session FROM anchor_interactive_sessions WHERE idempotency_key = $1',
    [key],
  );
  return rows[0]?.session;
}

export async function startInteractiveOnce(
  direction: 'deposit' | 'withdraw',
  account: string,
  currency: string,
  token: string,
  start: () => Promise<AnchorInteractiveSession>,
): Promise<AnchorInteractiveSession> {
  const key = startIdempotencyKey(direction, account, currency, token);
  const cached = await findSession(key);
  if (cached) return cached;

  // Held only for the duration of the anchor call, on its own connection, so
  // a concurrent duplicate waits here instead of calling the anchor twice.
  const lockClient = await pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', [`anchor-start:${key}`]);
    try {
      const existing = await findSession(key);
      if (existing) return existing;
      const session = await start();
      await pool.query(
        `INSERT INTO anchor_interactive_sessions (idempotency_key, direction, session) VALUES ($1, $2, $3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [key, direction, JSON.stringify(session)],
      );
      return session;
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [`anchor-start:${key}`]).catch(() => undefined);
    }
  } finally {
    lockClient.release();
  }
}
