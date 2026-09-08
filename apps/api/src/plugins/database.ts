import fp from 'fastify-plugin';
import { closeDatabase, createDatabase, runMigrations, type Database } from '@devflow/database';
import { env } from '../config/env';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
  }
}

/**
 * Creates the process-wide Postgres connection (one pool per process), runs
 * pending migrations at boot, and closes the pool on shutdown.
 */
export const databasePlugin = fp(async (app) => {
  const db = createDatabase(env.DATABASE_URL);

  app.log.info('Running database migrations');
  await runMigrations(db);
  app.log.info('Database migrations complete');

  app.decorate('db', db);

  app.addHook('onClose', async () => {
    await closeDatabase(db);
  });
});
