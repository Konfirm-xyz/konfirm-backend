// Deliberately the only way to create an admin account — there is no
// POST /admin/auth/signup endpoint, on purpose (see admin-auth.controller.ts).
// An internet-facing "create an admin" route would be its own security
// problem; provisioning out-of-band via direct database access is the
// correct amount of friction for a highly privileged account.
import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres:///konfirm_dev' });

async function main(): Promise<void> {
  const [, , rawEmail, password, ...nameParts] = process.argv;
  const email = rawEmail?.trim().toLowerCase();
  const name = nameParts.join(' ');
  if (!email || !password || !name) {
    console.error('usage: ts-node db/seed-admin.ts <email> <password> <name>');
    process.exitCode = 1;
    return;
  }
  if (password.length < 8) {
    console.error('password must be at least 8 characters');
    process.exitCode = 1;
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO admins (email, password_hash, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name
     RETURNING id, email, name`,
    [email, passwordHash, name],
  );
  console.log(`admin ready: ${rows[0].email} (${rows[0].id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
