import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * Options-in: the caller supplies the connection string; this package never
 * reads process.env. Call this once per process (one pool per process) and
 * pass the resulting `Database` into modules — do not call it repeatedly.
 */
export function createDatabase(connectionString: string) {
  // Suppress driver-level NOTICE console spam (e.g. idempotent "already
  // exists, skipping" from the migrator's bookkeeping table/schema).
  const client = postgres(connectionString, { onnotice: () => {} });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDatabase>;

/** The transaction-scoped client passed to `db.transaction(async (tx) => ...)`. */
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Graceful shutdown: closes the underlying connection pool. */
export async function closeDatabase(db: Database): Promise<void> {
  await db.$client.end();
}
