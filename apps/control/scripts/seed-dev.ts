import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent';
const username = process.env.LOCAL_ADMIN_USERNAME ?? 'tenant-admin';
const password = process.env.LOCAL_ADMIN_PASSWORD ?? 'opsagent-dev';

const pool = new Pool({ connectionString: databaseUrl });
try {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
  await seed(pool);
  await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [
    await hash(password),
    username,
  ]);
  console.log(`seeded dev database; local admin: ${username}`);
} finally {
  await pool.end();
}
