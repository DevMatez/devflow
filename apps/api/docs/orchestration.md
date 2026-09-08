# Orchestration: how `apps/api` wires the foundation packages together

`apps/api` is the **composition root** — the only place in the monorepo that
imports every Wave 0 foundation package and wires them together at runtime.
Each package's own README documents its contract in isolation; this doc is
the one to read to understand how they combine into a running system. Start
here when onboarding.

Packages involved: [`@devflow/config`](../../../packages/config/README.md),
[`@devflow/observability`](../../../packages/observability/README.md),
[`@devflow/database`](../../../packages/database/README.md),
[`@devflow/queue`](../../../packages/queue/README.md),
[`@devflow/events`](../../../packages/events/README.md).

---

## 1. Dependency graph

```mermaid
graph LR
    config["@devflow/config"] --> api["apps/api"]
    observability["@devflow/observability"] --> api
    database["@devflow/database"] --> events["@devflow/events"]
    queue["@devflow/queue"] --> events
    database --> api
    queue --> api
    events --> api
```

`@devflow/events` depends on `database` (the `DatabaseTransaction` type and
the `outbox_events` table contract) and `queue` (`JobHandle`, `jobId`) —
`apps/api` doesn't need to know that; it only calls `publishOutbox`,
`defineRoute`, and `relayOutboxOnce`.

## 2. Boot sequence

`buildApp()` in [`src/app.ts`](../src/app.ts) registers plugins in a fixed
order, because later plugins depend on decorators earlier ones add:

| Order | Plugin                                                | What it does                                                                                                          | Decorates               |
| ----- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1     | _(inline)_                                            | `createEnv` validates `process.env` (fails fast if missing/invalid) — see [`src/config/env.ts`](../src/config/env.ts) | —                       |
| 2     | _(inline)_                                            | `createLogger` from `@devflow/observability` becomes Fastify's `loggerInstance`                                       | `app.log`               |
| 3     | `sensible`, `helmet`, `cors`, `rateLimit`             | Standard Fastify hardening plugins                                                                                    | —                       |
| 4     | [`correlationPlugin`](../src/plugins/correlation.ts)  | Reads/generates a correlation id per request                                                                          | `request.correlationId` |
| 5     | [`databasePlugin`](../src/plugins/database.ts)        | `createDatabase(env.DATABASE_URL)`, runs migrations, closes pool on shutdown                                          | `app.db`                |
| 6     | [`queuePlugin`](../src/plugins/queue.ts)              | `createConnection(env.REDIS_URL)`, calls `configureQueue({ connection })`                                             | `app.redis`             |
| 7     | [`outboxRelayPlugin`](../src/plugins/outbox-relay.ts) | Defines the demo job/route, starts the queue worker and the relay interval                                            | —                       |
| 8     | `openapiPlugin`                                       | OpenAPI spec + Scalar docs UI (`/doc`)                                                                                | —                       |
| 9     | `registerRoutes`                                      | Mounts versioned routes (`/api/v1/...`)                                                                               | —                       |

Plugins 5–7 need `env.DATABASE_URL`/`env.REDIS_URL` (step 1) and `app.log`
(step 2), and routes registered in step 9 need `app.db` (step 5) — hence the
fixed order.

```mermaid
sequenceDiagram
    participant Boot as buildApp
    participant Cfg as devflow-config
    participant Obs as devflow-observability
    participant DB as databasePlugin
    participant Q as queuePlugin
    participant Relay as outboxRelayPlugin

    Boot->>Cfg: createEnv schema
    Cfg-->>Boot: env, typed and validated
    Boot->>Obs: createLogger level, pretty
    Obs-->>Boot: logger becomes loggerInstance
    Boot->>DB: createDatabase env.DATABASE_URL
    DB->>DB: runMigrations db
    DB-->>Boot: app.db decorated
    Boot->>Q: createConnection env.REDIS_URL
    Q->>Q: configureQueue connection
    Q-->>Boot: app.redis decorated
    Boot->>Relay: createWorker app.redis, runInContext
    Boot->>Relay: setInterval relayOutboxOnce, 2000ms
```

## 3. Request lifecycle — correlation id

Every request gets one correlation id that threads through logs, the outbox
event, the relayed queue job, and the worker that processes it:

```mermaid
sequenceDiagram
    participant Client
    participant Correlation as correlationPlugin
    participant Route
    participant Service
    participant Logger as app.log

    Client->>Correlation: HTTP request, x-correlation-id header optional
    Correlation->>Correlation: use header or generateCorrelationId
    Correlation->>Correlation: runWithCorrelationId id, next request handling
    Correlation->>Route: set request.correlationId
    Route->>Service: pass correlationId explicitly
    Service->>Logger: logger.info - id attached automatically via ALS mixin
    Correlation-->>Client: response, x-correlation-id header echoed back
```

`runWithCorrelationId` uses Node's `AsyncLocalStorage`, so `app.log`'s
`mixin()` (in `@devflow/observability`) picks up the id in every log line for
the rest of that request's async chain — including inside the queue worker,
because `outboxRelayPlugin` passes `runWithCorrelationId` in as the worker's
`runInContext` callback.

## 4. Outbox event lifecycle (worked example: `system.pinged`)

[`modules/system`](../src/modules/system) is a minimal, self-contained
example proving the full pipeline; it's not a real domain module (see
[`phase-1.md`](../../../phase-1.md) Wave 0 "done when" criterion). Use it as
the template when wiring a real domain event.

| File                                                                                          | Role                                                                                |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`modules/system/events.ts`](../src/modules/system/events.ts)                                 | `SystemPinged = defineEvent({...})` — the event contract                            |
| [`modules/system/jobs/system-ping.job.ts`](../src/modules/system/jobs/system-ping.job.ts)     | `createSystemPingJob(logger)` — the `@devflow/queue` job that consumes it           |
| [`modules/system/routing.ts`](../src/modules/system/routing.ts)                               | `createSystemPingRoute(job)` — maps the event to the job (`defineRoute`)            |
| [`modules/system/service/system.service.ts`](../src/modules/system/service/system.service.ts) | `pingSystem(db, input)` — writes the event via `publishOutbox` inside a transaction |
| [`routes/v1/system/router.ts`](../src/routes/v1/system/router.ts)                             | `POST /api/v1/system/ping` — the HTTP trigger                                       |

```mermaid
sequenceDiagram
    participant Client
    participant Router as system router
    participant Service as pingSystem
    participant DB as Postgres outbox_events
    participant Relay as outbox relay, 2s interval
    participant Queue as BullMQ system-ping
    participant Worker as systemPingJob worker

    Client->>Router: POST organizationId, message
    Router->>Service: pingSystem db, correlationId
    Service->>DB: db.transaction - publishOutbox tx, event
    DB-->>Service: row committed, relayed_at is null
    Service-->>Router: eventId
    Router-->>Client: 202 eventId, correlationId

    Note over Relay: next tick, independent of the request
    Relay->>DB: claim batch, SKIP LOCKED, set claim_expires_at
    Relay->>Queue: route.enqueue event, jobId is namespaced
    Relay->>DB: mark relayed_at, or record attempts/last_error
    Queue->>Worker: deliver job
    Worker->>Worker: logger.info inside runWithCorrelationId
```

The HTTP response (`202`) returns **before** the event is relayed — the
outbox pattern is intentionally async. This is at-least-once delivery, not
exactly-once (see `@devflow/events`' README); the demo job handler is
idempotent-safe because it only logs.

### Adding a real event-driven flow

1. Define the event in the owning module: `defineEvent({ type, schemaVersion, schema })`.
2. Define the job: `defineJob({ name, version, schema, handler })` — schema typed as `z.ZodType<...>`, not the narrower `z.object(...)` return type, so it satisfies `@devflow/events`' `EventRoute['job']` (see `modules/system/jobs/system-ping.job.ts` for why).
3. Map them: `defineRoute({ name, event, job, toJobPayload })`.
4. In the service, publish inside the same transaction as the state change: `db.transaction(async (tx) => { ...state change...; await publishOutbox(tx, event); })`.
5. Add the route to the array passed to `relayOutboxOnce` in [`outbox-relay.ts`](../src/plugins/outbox-relay.ts), and start the job's worker there too.

## 5. Shutdown sequence

`server.ts` calls `app.close()` on `SIGINT`/`SIGTERM`, which runs every
plugin's `onClose` hook — order is the reverse of registration:

1. `outboxRelayPlugin` — clears the relay interval, closes the BullMQ worker.
2. `queuePlugin` — quits the Redis connection.
3. `databasePlugin` — closes the Postgres pool (`closeDatabase`).

## 6. Environment variables

| Var                                     | Required      | Notes                                                                                      |
| --------------------------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                          | yes           | e.g. `postgres://devflow:devflow@localhost:5433/devflow` (docker-compose maps host `5433`) |
| `REDIS_URL`                             | yes           | e.g. `redis://localhost:6379`                                                              |
| `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL` | no (defaults) | see [`apps/api/README.md`](../README.md)                                                   |

CI provisions Postgres + Redis as GitHub Actions service containers (see
[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)) — `apps/api`
now needs live infra to even boot (migrations run at startup), so its test
task can't run infra-free. `turbo.json` explicitly passes `DATABASE_URL`/
`REDIS_URL` through to the `dev` and `test` tasks (Turborepo's strict env
mode otherwise strips undeclared env vars).

## 7. Known Wave-0 simplifications (revisit later)

- The queue worker runs **in-process** inside `apps/api`. Move it to a
  dedicated `apps/worker` process once job volume/isolation needs justify it
  (§12 in `project.md`).
- Vitest runs `apps/api`'s test files **sequentially**
  (`vitest.config.ts`'s `fileParallelism: false`) because they share one live
  Postgres/Redis and each calls `buildApp()`, which runs real migrations —
  running them in parallel processes races on `CREATE SCHEMA`.
