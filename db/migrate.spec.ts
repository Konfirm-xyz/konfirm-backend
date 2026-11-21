/**
 * Unit tests for db/migrate.ts's orchestration layer — up()/down() pending-file
 * discovery, sorting, and the down() safety check for missing .down.sql files.
 *
 * These tests use a real tmpdir with real .sql files and a fake Pool so they
 * exercise the actual file-system logic without touching a database.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { up, down } from './migrate';

// ── Minimal fake Pool ──────────────────────────────────────────────────────

type Row = { name: string };

function fakePool(applied: string[] = []): Pool {
  // Track which names are in schema_migrations.
  const rows = new Set<string>(applied);

  const query = jest.fn((sql: string, params?: unknown[]) => {
    if (sql.startsWith('CREATE TABLE')) return Promise.resolve({ rows: [] });
    if (sql.startsWith('SELECT name FROM schema_migrations')) return Promise.resolve({ rows: [...rows].map((name) => ({ name })) });
    if (sql.startsWith('SELECT name FROM schema_migrations ORDER BY')) {
      const limit = Number((params as number[])[0]);
      const toRevert = [...rows].slice(-limit);
      return Promise.resolve({ rows: toRevert.map((name) => ({ name })) });
    }
    if (sql.startsWith('INSERT INTO schema_migrations')) {
      rows.add((params as string[])[0]);
      return Promise.resolve({ rows: [] });
    }
    if (sql.startsWith('DELETE FROM schema_migrations')) {
      rows.delete((params as string[])[0]);
      return Promise.resolve({ rows: [] });
    }
    // applyMigrationSql's transactional path goes through a client
    return Promise.resolve({ rows: [] });
  });

  const client = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };

  return {
    query,
    connect: jest.fn().mockResolvedValue(client),
    _rows: rows,
  } as unknown as Pool;
}

// ── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `migrate-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeMigration(name: string, upSql = 'SELECT 1', downSql = 'SELECT 2'): void {
  writeFileSync(join(tmpDir, `${name}.up.sql`), upSql);
  writeFileSync(join(tmpDir, `${name}.down.sql`), downSql);
}

function writeUpOnly(name: string, upSql = 'SELECT 1'): void {
  writeFileSync(join(tmpDir, `${name}.up.sql`), upSql);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('up()', () => {
  it('applies all pending migrations in sorted order', async () => {
    writeMigration('002_b');
    writeMigration('001_a');
    const pool = fakePool([]);

    await up(pool, tmpDir);

    // Both should now be recorded (we track INSERT calls).
    const inserts = (pool.query as jest.Mock).mock.calls
      .filter(([sql]: [string]) => sql.startsWith('INSERT INTO schema_migrations'))
      .map(([, params]: [string, string[]]) => params[0]);
    expect(inserts).toEqual(['001_a', '002_b']);
  });

  it('skips already-applied migrations', async () => {
    writeMigration('001_a');
    writeMigration('002_b');
    const pool = fakePool(['001_a']); // 001_a already applied

    await up(pool, tmpDir);

    const inserts = (pool.query as jest.Mock).mock.calls
      .filter(([sql]: [string]) => sql.startsWith('INSERT INTO schema_migrations'))
      .map(([, params]: [string, string[]]) => params[0]);
    expect(inserts).toEqual(['002_b']);
  });

  it('does nothing when all migrations are applied', async () => {
    writeMigration('001_a');
    const pool = fakePool(['001_a']);

    await up(pool, tmpDir);

    const inserts = (pool.query as jest.Mock).mock.calls.filter(([sql]: [string]) =>
      sql.startsWith('INSERT INTO schema_migrations'),
    );
    expect(inserts).toHaveLength(0);
  });
});

describe('down()', () => {
  it('reverts the most recent migration by default (steps=1)', async () => {
    writeMigration('001_a');
    writeMigration('002_b');
    const pool = fakePool(['001_a', '002_b']);

    await down(1, pool, tmpDir);

    const deletes = (pool.query as jest.Mock).mock.calls
      .filter(([sql]: [string]) => sql.startsWith('DELETE FROM schema_migrations'))
      .map(([, params]: [string, string[]]) => params[0]);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toBe('002_b');
  });

  it('throws when a .down.sql file is missing', async () => {
    writeUpOnly('001_no_down');
    const pool = fakePool(['001_no_down']);

    await expect(down(1, pool, tmpDir)).rejects.toThrow('no down-migration found');
  });

  it('does nothing when nothing has been applied', async () => {
    const pool = fakePool([]);

    await expect(down(1, pool, tmpDir)).resolves.toBeUndefined();
    const deletes = (pool.query as jest.Mock).mock.calls.filter(([sql]: [string]) =>
      sql.startsWith('DELETE FROM schema_migrations'),
    );
    expect(deletes).toHaveLength(0);
  });
});
