import { Pool } from 'pg';
import { applyMigrationSql, isNonTransactional, runUp } from '../db/migrate';

// Regression for CREATE INDEX CONCURRENTLY: Postgres rejects it inside a
// transaction block, so it only works through the runner's `-- no-transaction`
// path. Runs against the real test database, not a mock.
describe('migration runner non-transactional path (e2e)', () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const table = 'migrate_concurrent_probe';
  const tracking = 'migrate_concurrent_probe_tracking';

  beforeAll(async () => {
    await db.query(`DROP TABLE IF EXISTS ${table}, ${tracking}`);
    await db.query(`CREATE TABLE ${table} (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE ${tracking} (name TEXT PRIMARY KEY)`);
  });

  afterAll(async () => {
    await db.query(`DROP TABLE IF EXISTS ${table}, ${tracking}`);
    await db.end();
  });

  it('detects the marker only on the first line', () => {
    expect(isNonTransactional('-- no-transaction\nCREATE INDEX CONCURRENTLY x ON y (z);')).toBe(true);
    expect(isNonTransactional('CREATE TABLE t ();\n-- no-transaction')).toBe(false);
    expect(isNonTransactional('-- no-transactional\nSELECT 1;')).toBe(false);
  });

  it('applies CREATE INDEX CONCURRENTLY and records it', async () => {
    const sql = `-- no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_created_at_idx ON ${table} (created_at);`;
    await applyMigrationSql(db, sql, `INSERT INTO ${tracking} (name) VALUES ($1)`, ['999_probe']);

    const idx = await db.query(`SELECT indisvalid FROM pg_index WHERE indexrelid = '${table}_created_at_idx'::regclass`);
    expect(idx.rows[0].indisvalid).toBe(true);
    const tracked = await db.query(`SELECT name FROM ${tracking}`);
    expect(tracked.rows.map((r) => r.name)).toEqual(['999_probe']);
  });

  it('still rejects CONCURRENTLY without the marker (transactional path)', async () => {
    const sql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_id_idx ON ${table} (id);`;
    await expect(applyMigrationSql(db, sql, `INSERT INTO ${tracking} (name) VALUES ($1)`, ['998_probe'])).rejects.toThrow(
      /cannot run inside a transaction block/,
    );
    const tracked = await db.query(`SELECT name FROM ${tracking} WHERE name = '998_probe'`);
    expect(tracked.rowCount).toBe(0);
  });
});

// Regression for the silent-drift bug class: an already-applied migration file
// whose content changed must make `up` fail loudly instead of being ignored.
describe('migration runner checksum guard (e2e)', () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const table = 'migrate_checksum_probe';

  beforeAll(async () => {
    await db.query(`DROP TABLE IF EXISTS ${table}`);
    await db.query('DROP TABLE IF EXISTS schema_migrations');
  });

  afterAll(async () => {
    await db.query(`DROP TABLE IF EXISTS ${table}`);
    await db.query('DROP TABLE IF EXISTS schema_migrations');
    await db.end();
  });

  it('records a checksum and rejects an edited already-applied migration', async () => {
    await runUp();
    const applied = await db.query(`SELECT checksum FROM schema_migrations WHERE name = '001_merchants'`);
    expect(applied.rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);

    // Simulate the file having been edited after it was applied.
    await db.query(`UPDATE schema_migrations SET checksum = $1 WHERE name = '001_merchants'`, ['0'.repeat(64)]);

    await expect(runUp()).rejects.toThrow(/checksum mismatch/);
    // Nothing new was applied.
    const count = await db.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
    expect(count.rows[0].n).toBe(1);
  });
});
