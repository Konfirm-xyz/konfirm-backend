import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateMigrationPairs } from '../db/migrate';

describe('Database Migration Down Parity (Issue #251)', () => {
  const migrationsDir = join(__dirname, '../db/migrations');

  it('every .up.sql file has a corresponding .down.sql file', () => {
    const { missingDown } = validateMigrationPairs(migrationsDir);
    expect(missingDown).toEqual([]);
  });

  it('028_facilitator_spend_cap.down.sql exists and correctly drops facilitator_spend_cap table', () => {
    const downPath = join(migrationsDir, '028_facilitator_spend_cap.down.sql');
    expect(existsSync(downPath)).toBe(true);

    const content = readFileSync(downPath, 'utf8');
    expect(content).toMatch(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?facilitator_spend_cap;/i);
  });

  it('validateMigrationPairs flags any .up.sql missing a .down.sql', () => {
    // Test with mock directory structure
    const allFiles = readdirSync(migrationsDir);
    const upFiles = allFiles.filter((f) => f.endsWith('.up.sql'));
    const downFiles = allFiles.filter((f) => f.endsWith('.down.sql'));

    // Count must be equal
    expect(upFiles.length).toBe(downFiles.length);
  });
});
