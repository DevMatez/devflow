import { Redis, type RedisOptions } from 'ioredis';

export type RedisConnection = Redis;

/**
 * Creates a Redis connection for queues and workers. `maxRetriesPerRequest`
 * must be null for BullMQ blocking operations.
 */
export function createConnection(url: string, options?: RedisOptions): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, ...options });
}
