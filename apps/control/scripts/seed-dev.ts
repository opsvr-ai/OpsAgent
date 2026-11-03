import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent';
const username = process.env.LOCAL_ADMIN_USERNAME ?? 'tenant-admin';
const password = process.env.LOCAL_ADMIN_PASSWORD ?? 'opsagent-dev';
const usernames = [
  username,
  ...(process.env.LOCAL_ADMIN_USERNAMES ?? 'tenant-admin,platform-admin').split(','),
]
  .map((item) => item.trim())
  .filter(Boolean);

const pool = new Pool({ connectionString: databaseUrl });
try {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
  await seed(pool);
  const passwordHash = await hash(password);
  for (const name of [...new Set(usernames)]) {
    await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [
      passwordHash,
      name,
    ]);
  }
  console.log(`seeded dev database; local admins: ${[...new Set(usernames)].join(', ')}`);
} finally {
  await pool.end();
}
