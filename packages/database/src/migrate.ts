import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Database } from './client';

// Resolved relative to this package's own file location — correct regardless
// of where the consuming app lives in the monorepo.
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

/** Applies pending migrations. Call once at process boot, before serving traffic. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}
