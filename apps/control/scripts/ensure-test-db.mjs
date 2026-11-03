import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://opsagent:opsagent@localhost:5432/postgres';
const testUrl = process.env.TEST_DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent_test';
const database = new URL(testUrl).pathname.replace(/^\//, '') || 'opsagent_test';

const pool = new pg.Pool({ connectionString: adminUrl });
try {
  const exists = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (exists.rowCount === 0) {
    await pool.query(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
    console.log(`created test database ${database}`);
  } else {
    console.log(`test database ${database} ready`);
  }
} finally {
  await pool.end();
}
