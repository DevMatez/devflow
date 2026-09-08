import { Worker, type Processor, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';

export interface CreateWorkerOptions {
  connection: Redis;
  concurrency?: number;
}

/** Creates a BullMQ worker. The returned handle exposes `close()` for graceful shutdown. */
export function createWorker<T = unknown, R = unknown>(
  name: string,
  processor: Processor<T, R>,
  options: CreateWorkerOptions,
): Worker<T, R> {
  const workerOptions: WorkerOptions = {
    connection: options.connection,
    concurrency: options.concurrency ?? 1,
  };

  return new Worker<T, R>(name, processor, workerOptions);
}
