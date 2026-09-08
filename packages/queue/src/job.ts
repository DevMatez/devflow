import { Queue, type JobsOptions, type Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createQueue } from './queue';
import { createWorker } from './worker';
import { withTimeout } from './timeout';

export interface JobContext {
  jobId?: string;
  correlationId: string;
  organizationId: string;
  attempt: number;
}

export interface JobDefinition<S extends z.ZodType> {
  name: string;
  version: number;
  schema: S;
  defaults?: JobsOptions;
  timeout?: number;
  handler: (payload: z.infer<S>, ctx: JobContext) => Promise<void>;
}

export interface EnqueueOptions {
  jobId?: string;
  correlationId?: string;
}

/** Optional correlation wrapper injected by the host (e.g. `@devflow/observability`). */
export type RunInContext = <T>(correlationId: string, fn: () => Promise<T>) => Promise<T>;

export interface WorkerOptions {
  concurrency?: number;
  runInContext?: RunInContext;
}

interface JobEnvelope<T> {
  payload: T;
  meta: { correlationId: string; organizationId: string; version: number };
}

/** The connection is provided once by the host app (options-in; no env reads). */
let sharedConnection: Redis | undefined;

export function configureQueue(options: { connection: Redis }): void {
  sharedConnection = options.connection;
}

function requireConnection(): Redis {
  if (!sharedConnection) {
    throw new Error('configureQueue({ connection }) must be called before enqueuing jobs');
  }
  return sharedConnection;
}

export interface JobHandle<S extends z.ZodType> {
  name: string;
  version: number;
  schema: S;
  enqueue: (
    payload: z.infer<S> & { organizationId: string },
    options?: EnqueueOptions,
  ) => Promise<void>;
  createWorker: (connection: Redis, options?: WorkerOptions) => Worker;
}

export function defineJob<S extends z.ZodType>(def: JobDefinition<S>): JobHandle<S> {
  let queue: Queue | undefined;
  const getQueue = (): Queue =>
    (queue ??= createQueue(def.name, {
      connection: requireConnection(),
      defaultJobOptions: def.defaults,
    }));

  async function enqueue(
    payload: z.infer<S> & { organizationId: string },
    options: EnqueueOptions = {},
  ): Promise<void> {
    // Validate at the enqueue boundary before touching Redis.
    const data = def.schema.parse(payload);
    const envelope: JobEnvelope<z.infer<S>> = {
      payload: data,
      meta: {
        correlationId: options.correlationId ?? randomUUID(),
        organizationId: (payload as { organizationId: string }).organizationId,
        version: def.version,
      },
    };

    await getQueue().add(def.name, envelope, { jobId: options.jobId });
  }

  function createDefWorker(connection: Redis, options?: WorkerOptions): Worker {
    const dead = new Queue(`${def.name}.dead`, { connection });

    const worker = createWorker<JobEnvelope<z.infer<S>>>(
      def.name,
      async (job) => {
        // Validate again at the worker boundary (guards producer/consumer skew).
        const data = def.schema.parse(job.data.payload);
        const { correlationId, organizationId } = job.data.meta;

        const run = (): Promise<void> =>
          withTimeout(def.timeout, () =>
            def.handler(data, {
              jobId: job.id,
              correlationId,
              organizationId,
              attempt: job.attemptsMade + 1,
            }),
          );

        await (options?.runInContext ? options.runInContext(correlationId, run) : run());
      },
      { connection, concurrency: options?.concurrency },
    );

    // Route exhausted jobs to the dead-letter queue (never silently dropped).
    worker.on('failed', (job, err) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void dead.add(
          def.name,
          { payload: job.data, error: err.message, failedAt: new Date().toISOString() },
          { jobId: job.id ? `dead:${job.id}` : undefined },
        );
      }
    });

    return worker;
  }

  return {
    name: def.name,
    version: def.version,
    schema: def.schema,
    enqueue,
    createWorker: createDefWorker,
  };
}
