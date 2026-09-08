import { Queue, type JobsOptions, type QueueOptions } from 'bullmq';
import type { Redis } from 'ioredis';

/** Platform default retry/backoff policy applied to every queue. */
export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};

export interface CreateQueueOptions {
  connection: Redis;
  defaultJobOptions?: JobsOptions;
}

export function createQueue(name: string, options: CreateQueueOptions): Queue {
  const queueOptions: QueueOptions = {
    connection: options.connection,
    defaultJobOptions: { ...defaultJobOptions, ...options.defaultJobOptions },
  };

  return new Queue(name, queueOptions);
}
