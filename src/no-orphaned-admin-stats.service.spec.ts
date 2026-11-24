import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = __dirname; // src/

/**
 * Regression for the orphaned `src/services/admin-stats.service.ts`.
 *
 * That file was a dead duplicate of the real, wired-in
 * `src/admin/admin-stats.service.ts`. Nothing imported it, and its presence
 * was what let an earlier fix land in the wrong file. It must stay gone.
 */
describe('no orphaned admin-stats service under src/services', () => {
  it('does not ship a src/services/admin-stats.service.ts', () => {
    expect(
      fs.existsSync(path.join(SRC, 'services', 'admin-stats.service.ts')),
    ).toBe(false);
  });

  it('has no source file importing from the dead services path', () => {
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const contents = fs.readFileSync(full, 'utf8');
          if (/from\s+['"][^'"]*services\/admin-stats['"]/.test(contents)) {
            offenders.push(path.relative(SRC, full));
          }
        }
      }
    };

    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
