// A deliberately small migration runner — no framework, matching the
// project's existing "raw pg, no ORM" approach. Tracks what's been applied
// in a schema_migrations table so `up` only ever runs what's actually
// pending, and `down` can revert the most recent migration(s) for real,
// which the previous `for f in *.sql; do psql -f "$f"; done` approach never
// could — it had no record of state and no way back.
import { createHash } from 'node:crypto';
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

// SHA-256 of the migration file's exact bytes. Recorded at apply time so a
// later edit to an already-applied file is caught instead of silently
// ignored — the bug class that let 006_admins' role column drift unnoticed.
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

async function ensureTrackingTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Existing installs predate the checksum column; add it in place. Rows
  // applied before this change have NULL and are backfilled on the next `up`.
  await pool.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
}

// Fails loudly, before applying anything, when an already-applied migration
// file no longer matches the checksum recorded when it ran. NULL checksums
// (rows from before checksums existed) are backfilled rather than rejected.
async function verifyAppliedChecksums(): Promise<void> {
  const { rows } = await pool.query('SELECT name, checksum FROM schema_migrations');
  const mismatches: string[] = [];

  for (const { name, checksum } of rows as { name: string; checksum: string | null }[]) {
    const file = join(MIGRATIONS_DIR, `${name}.up.sql`);
    if (!existsSync(file)) {
      mismatches.push(`${name}: applied but ${name}.up.sql is missing`);
      continue;
    }
    const actual = checksumOf(readFileSync(file, 'utf8'));
    if (checksum === null) {
      await pool.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [name, actual]);
    } else if (checksum !== actual) {
      mismatches.push(`${name}: recorded ${checksum}, file is now ${actual}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `migration checksum mismatch — refusing to apply anything:\n  ${mismatches.join('\n  ')}\n` +
        'An already-applied migration file was edited. Revert the edit and add a new migration instead.',
    );
  }
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

// Every .up.sql must have a matching .down.sql, otherwise `down` can only
// fail halfway through a revert. Checked before applying anything so a
// missing pair is caught at startup rather than at rollback time.
export function findMissingDownMigrations(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.up.sql'))
    .filter((f) => !existsSync(join(dir, f.replace(/\.up\.sql$/, '.down.sql'))))
    .sort();
}

function assertDownMigrationsExist(): void {
  const missing = findMissingDownMigrations();
  if (missing.length > 0) {
    throw new Error(
      `missing down-migration(s) for: ${missing.join(', ')} — every .up.sql needs a matching .down.sql`,
    );
  }
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

export function validateMigrationPairs(dir: string = MIGRATIONS_DIR): { missingDown: string[] } {
  const files = readdirSync(dir);
  const upFiles = files.filter((f) => f.endsWith('.up.sql'));
  const missingDown: string[] = [];
  for (const f of upFiles) {
    const base = f.replace(/\.up\.sql$/, '');
    const downFile = join(dir, `${base}.down.sql`);
    if (!existsSync(downFile)) {
      missingDown.push(base);
    }
  }
  return { missingDown };
}

async function up(): Promise<void> {
  const { missingDown } = validateMigrationPairs();
  if (missingDown.length > 0) {
    throw new Error(`missing .down.sql migration(s): ${missingDown.join(', ')} — every migration must have a reversible down path`);
  }

  await ensureTrackingTable();
  await verifyAppliedChecksums();
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
    await applyMigrationSql(pool, sql, 'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksumOf(sql)]);
  }
  console.log(`applied ${pending.length} migration(s).`);
}

async function down(steps: number): Promise<void> {
  assertDownMigrationsExist();
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

// Exported for the checksum regression test, which drives `up` against a
// throwaway migrations directory.
export { up as runUp, verifyAppliedChecksums };
