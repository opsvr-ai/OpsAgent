import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

export async function migrate(pool: Pool): Promise<void> {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
    await pool.query(sql);
  }
}
