// A deliberately small migration runner — no framework, matching the
// project's existing "raw pg, no ORM" approach. Tracks what's been applied
// in a schema_migrations table so `up` only ever runs what's actually
// pending, and `down` can revert the most recent migration(s) for real,
// which the previous `for f in *.sql; do psql -f "$f"; done` approach never
// could — it had no record of state and no way back.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const MIGRATIONS_DIR = join(__dirname, 'migrations');
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres:///konfirm_dev' });

// Postgres refuses CREATE INDEX CONCURRENTLY inside a transaction block, and
// CONCURRENTLY is the only way to index a hot table (payments, etc.) without
// a SHARE lock blocking every write for the whole build. A migration whose
// first line is exactly this marker runs outside BEGIN/COMMIT. Keep such a
// file to a single statement: there's no rollback, so a multi-statement
// file that fails halfway stays half-applied. A failed CONCURRENTLY build
// leaves an INVALID index behind — write the .up.sql with IF NOT EXISTS and
// the .down.sql with DROP INDEX CONCURRENTLY IF EXISTS so a retry is clean.
export const NO_TRANSACTION_MARKER = '-- no-transaction';

export function isNonTransactional(sql: string): boolean {
  return sql.split(/\r?\n/, 1)[0].trim() === NO_TRANSACTION_MARKER;
}

async function ensureTrackingTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// Two files sharing a numeric prefix (e.g. three `023_*`, five `028_*`) sort
// by their name suffix, so a fresh build applies them in an order that has
// nothing to do with when they actually landed — and can't be reconciled with
// the order production already applied them in. Prefixes must be unique.
export function findDuplicatePrefixes(files: string[]): Map<string, string[]> {
  const byPrefix = new Map<string, string[]>();
  for (const file of files) {
    const match = /^(\d+)_/.exec(file);
    if (!match) continue;
    const group = byPrefix.get(match[1]) ?? [];
    group.push(file);
    byPrefix.set(match[1], group);
  }
  return new Map([...byPrefix].filter(([, group]) => group.length > 1));
}

export function assertUniquePrefixes(files: string[]): void {
  const duplicates = findDuplicatePrefixes(files);
  if (duplicates.size === 0) return;
  const detail = [...duplicates]
    .map(([prefix, group]) => `  ${prefix}: ${group.join(', ')}`)
    .join('\n');
  throw new Error(`duplicate migration prefixes — renumber so each prefix is unique:\n${detail}`);
}

function pendingUpFiles(applied: Set<string>): string[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.up.sql'));
  assertUniquePrefixes(files);
  return files.sort().filter((f) => !applied.has(f.replace(/\.up\.sql$/, '')));
}

// The migration's own SQL and its tracking-table record land in the same
// transaction — a failure applying one can't leave the other out of sync
// with what actually happened in the database.
async function runInTransaction(db: Pool, sql: string, trackingQuery: string, trackingParams: string[]): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(trackingQuery, trackingParams);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// The non-transactional path: the tracking row is written only after the
// SQL succeeds, so a failure leaves the migration pending (and retryable)
// rather than recorded as applied.
async function runWithoutTransaction(db: Pool, sql: string, trackingQuery: string, trackingParams: string[]): Promise<void> {
  await db.query(sql);
  await db.query(trackingQuery, trackingParams);
}

export async function applyMigrationSql(db: Pool, sql: string, trackingQuery: string, trackingParams: string[]): Promise<void> {
  if (isNonTransactional(sql)) {
    await runWithoutTransaction(db, sql, trackingQuery, trackingParams);
  } else {
    await runInTransaction(db, sql, trackingQuery, trackingParams);
  }
}

async function up(): Promise<void> {
  await ensureTrackingTable();
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name as string));
  const pending = pendingUpFiles(applied);

  if (pending.length === 0) {
    console.log('up to date — nothing to apply.');
    return;
  }

  for (const file of pending) {
    const name = file.replace(/\.up\.sql$/, '');
    console.log(`applying ${name}...`);
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await applyMigrationSql(pool, sql, 'INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
  }
  console.log(`applied ${pending.length} migration(s).`);
}

async function down(steps: number): Promise<void> {
  await ensureTrackingTable();
  const { rows } = await pool.query('SELECT name FROM schema_migrations ORDER BY applied_at DESC LIMIT $1', [steps]);

  if (rows.length === 0) {
    console.log('nothing to revert.');
    return;
  }

  for (const { name } of rows) {
    const downFile = join(MIGRATIONS_DIR, `${name}.down.sql`);
    if (!existsSync(downFile)) {
      throw new Error(`no down-migration found for ${name} (expected ${downFile}) — refusing to leave the tracking table out of sync`);
    }
    console.log(`reverting ${name}...`);
    const sql = readFileSync(downFile, 'utf8');
    await applyMigrationSql(pool, sql, 'DELETE FROM schema_migrations WHERE name = $1', [name]);
  }
  console.log(`reverted ${rows.length} migration(s).`);
}

async function main(): Promise<void> {
  const [, , cmd, arg] = process.argv;
  if (cmd === 'up') {
    await up();
  } else if (cmd === 'down') {
    await down(arg ? Number(arg) : 1);
  } else if (cmd === 'check') {
    // No database needed: CI runs this before `up` so a duplicate prefix
    // fails the build with a clear message instead of a confusing apply order.
    assertUniquePrefixes(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.up.sql')));
    console.log('migration prefixes are unique.');
  } else {
    console.error('usage: ts-node db/migrate.ts <up|down|check> [steps]');
    process.exitCode = 1;
    return;
  }
}

// Only run as a CLI — importing this module (the regression test does) must
// not kick off a real migration run against whatever DATABASE_URL is set.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
