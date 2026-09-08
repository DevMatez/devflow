# @devflow/queue

BullMQ-based background jobs for the DevFlow monorepo (see [`project.md`](../../project.md) §10).
Provides the platform's job-definition, retry, timeout, dead-letter, and idempotency conventions.

## Design

- **Leaf / options-in:** takes a Redis connection as an argument; never reads env; no dependency on `config`/`database`.
- **Transport, not the event store:** durability is the transactional outbox (`packages/database`). This package doesn't know the outbox schema.
- **Stays low-level:** reliably moves **typed** async work — never learns about GitHub/AI/Slack or domain semantics.
- **At-least-once:** delivery can repeat, so idempotency is two-level (below).

## Folder structure

```text
packages/queue/
├── src/
│   ├── index.ts        # public exports
│   ├── connection.ts   # createConnection(redis)
│   ├── job.ts          # defineJob() — the primary abstraction
│   ├── queue.ts        # createQueue() + defaultJobOptions
│   ├── worker.ts       # createWorker() (returns handle with close())
│   ├── ids.ts          # jobId(namespace, id)
│   └── __tests__/
├── package.json
├── tsconfig.json
└── README.md
```

## Public API

`defineJob` is the primary abstraction (`createQueue`/`createWorker` sit underneath).

| Export                    | Purpose                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| `defineJob(def)`          | `{ name, schema, defaults, timeout, version, handler }` + `enqueue` |
| `createConnection(redis)` | Shared Redis connection                                             |
| `createQueue(name, opts)` | Lower-level queue with default job-options                          |
| `createWorker(...)`       | Lower-level worker; handle exposes `close()` for graceful shutdown  |
| `jobId(namespace, id)`    | Deterministic job id for enqueue dedup                              |

## Conventions

- **Idempotency (both required):** deterministic `jobId` prevents duplicate **enqueue**; the handler must tolerate running **twice**.
- **`jobId(ns, id)`** → `"<ns>.<id>"` — deterministic, stable across retries, no transient data (delimiter is `.`, not `:` — BullMQ rejects a bare colon in custom ids).
- **Retry/backoff:** queue-level default + per-job override; `delay = min(maxDelay, base × 2^attempt) ± bounded jitter`.
- **Timeout:** every job has one; a hung job fails → retries.
- **Payload validation:** the job `schema` is validated at enqueue **and** at the worker boundary.
- **Dead-letter:** `main → retry × N → <name>.dead → alert → replay` (`replayDeadJob` in the contract; impl may defer past MVP).
- **Metadata:** every job carries `jobId`, `correlationId`, `organizationId` (+ optional `causationId`, `actorId`, `sourceEventId`); the host injects an optional `runInContext` wrapper (e.g. from `@devflow/observability`) so handlers run inside a correlation context — the package itself stays decoupled.
- **Rate limiting:** per-queue `limiter` hook, configured by feature modules — no provider policy here.

## Usage (target)

```ts
import { defineJob, jobId } from '@devflow/queue';
import { z } from 'zod';

export const aiReview = defineJob({
  name: 'ai-review',
  version: 1,
  schema: z.object({ prId: z.string(), organizationId: z.string() }),
  defaults: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
  timeout: 5 * 60_000,
  handler: async (job) => {
    /* idempotent */
  },
});

await aiReview.enqueue({ prId, organizationId }, { jobId: jobId('ai-review', outboxEventId) });
```

## Package relationships

|                 |                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Depends on**  | _(none)_ — zero internal `@devflow/*` dependencies (BullMQ + ioredis only)                                                                               |
| **Consumed by** | `@devflow/events` (`defineRoute` maps an event onto a job); `apps/api` (creates the shared Redis connection, calls `configureQueue`, starts job workers) |

## Scripts

| Script      | Purpose                |
| ----------- | ---------------------- |
| `typecheck` | `tsc --noEmit`         |
| `test`      | Run Vitest             |
| `clean`     | Remove build artifacts |

> Implemented: `connection.ts`, `queue.ts`, `worker.ts`, `job.ts` (`defineJob`), `ids.ts` (`jobId`). Note the `jobId` delimiter is `.` not `:` — BullMQ rejects custom job ids containing a bare colon.
