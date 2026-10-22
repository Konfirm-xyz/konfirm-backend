import { Pool } from 'pg';
import { applyMigrationSql, isNonTransactional } from '../db/migrate';

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
