import fp from 'fastify-plugin';
import { configureQueue, createConnection, type RedisConnection } from '@devflow/queue';
import { env } from '../config/env';

declare module 'fastify' {
  interface FastifyInstance {
    redis: RedisConnection;
  }
}

/**
 * Creates the shared Redis connection used by @devflow/queue's job
 * definitions (`configureQueue`) and closes it on shutdown.
 */
export const queuePlugin = fp(async (app) => {
  const connection = createConnection(env.REDIS_URL);
  configureQueue({ connection });

  app.decorate('redis', connection);

  app.addHook('onClose', async () => {
    await connection.quit();
  });
});
