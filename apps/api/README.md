# @devflow/api

The DevFlow backend HTTP API — a **Fastify + TypeScript modular monolith** (see [`project.md`](../../project.md) §4, §7).

> **New here?** Read [`docs/orchestration.md`](docs/orchestration.md) first — it
> explains how this app wires `@devflow/config`, `@devflow/observability`,
> `@devflow/database`, `@devflow/queue`, and `@devflow/events` together (boot
> sequence, correlation ids, the outbox → relay → queue → worker pipeline).

## Tech

| Concern     | Choice                                                               |
| ----------- | -------------------------------------------------------------------- |
| Runtime     | Node.js ≥ 20 (ESM)                                                   |
| HTTP        | Fastify 5                                                            |
| Validation  | Zod via `fastify-type-provider-zod`                                  |
| API docs    | OpenAPI (`@fastify/swagger`) + **Scalar** UI                         |
| Database    | Drizzle ORM (lives in `packages/database`, Wave 0)                   |
| Jobs/events | BullMQ (`@devflow/queue`) + transactional outbox (`@devflow/events`) |
| Logging     | Pino via `@devflow/observability` (correlation-id aware)             |
| Build / dev | `tsup` (bundle) / `tsx` (watch)                                      |
| Tests       | Vitest                                                               |

### Why Drizzle over Knex

Drizzle infers types end-to-end (schema → query → result), matching the shared-TypeScript-types goal (§15). Knex is an untyped query builder that would require hand-maintained types. Database access is **not** implemented in this app — it belongs in `packages/database` and is consumed here.

## Folder structure (module-oriented, §7)

Routes live **outside** the modules, grouped by API version: `routes/v<n>/<module>/{router,schema}`. Modules hold the **service** and **dal** layers; event-driven modules (e.g. `system`) additionally define their `events`, `jobs`, and `routing` (see [`docs/orchestration.md`](docs/orchestration.md) §4).

```text
apps/api/
├── src/
│   ├── config/            # env loading & validation (Zod)
│   ├── plugins/           # cross-cutting Fastify plugins
│   │   ├── correlation.ts     # per-request correlation id (AsyncLocalStorage)
│   │   ├── database.ts        # createDatabase + runMigrations, app.db
│   │   ├── queue.ts           # createConnection + configureQueue, app.redis
│   │   ├── outbox-relay.ts    # starts the relay interval + queue worker(s)
│   │   └── openapi.ts         # OpenAPI spec + Scalar docs UI
│   ├── routes/             # HTTP layer, versioned
│   │   ├── index.ts       # registerRoutes(): mounts each version behind its prefix
│   │   └── v1/
│   │       ├── index.ts   # v1Routes(): registers each module's router under /api/v1
│   │       ├── health/
│   │       │   ├── router.ts   # HTTP route (calls the module service)
│   │       │   └── schema.ts   # Zod request/response schemas (versioned)
│   │       └── system/     # Wave 0 outbox-pipeline proof, see docs/orchestration.md
│   │           ├── router.ts
│   │           └── schema.ts
│   ├── modules/           # feature modules — business + data only
│   │   ├── health/
│   │   │   ├── service/
│   │   │   │   └── health.service.ts  # business logic (uses dal)
│   │   │   ├── dal/
│   │   │   │   └── health.dal.ts      # data access layer
│   │   │   └── __tests__/
│   │   └── system/         # event-driven module (Wave 0 outbox proof)
│   │       ├── events.ts          # defineEvent(system.pinged)
│   │       ├── jobs/
│   │       │   └── system-ping.job.ts # defineJob that consumes the event
│   │       ├── routing.ts         # defineRoute(event → job)
│   │       └── service/
│   │           └── system.service.ts  # publishOutbox inside a transaction
│   ├── __tests__/         # app-wide tests (404s, docs wiring)
│   ├── app.ts             # buildApp(): assembles plugins + routes
│   └── server.ts          # entrypoint: listen + graceful shutdown
├── docs/
│   ├── orchestration.md          # how the foundation packages are wired together
│   └── api-docs-and-testing.md   # OpenAPI + testing conventions
├── tsup.config.ts
├── vitest.config.ts
└── tsconfig.json
```

### Layering rules

- **route** (`routes/v<n>/<module>/router.ts` + `schema.ts`) — HTTP concerns only: schema, status codes, calls a service. Versioned, lives outside modules.
- **service** (`modules/<module>/service/*.service.ts`) — business logic; orchestrates the dal and ports. Framework-free; never depends on the route layer.
- **dal** (`modules/<module>/dal/*.dal.ts`) — data access; the only layer that talks to the database (Drizzle) or external stores.

Dependency direction is one-way: **route → service → dal**. Adding a new API version means adding `routes/v2/<module>/` plus a `routes/v2/index.ts` aggregator — existing versions and module services are untouched.

### Database & the DAL vs `packages/database`

The DAL didn't move — it splits into two complementary layers:

- **`packages/database`** owns the shared database foundation: the Drizzle **client factory** (`createDatabase(url)`), the **schema** (all table definitions), and **migrations**. One connection config, one schema graph, one migration history — shared by `api` and `worker`.
- **`modules/<m>/dal`** owns **module-specific queries** (a thin repository) built on top of that shared client + schema.

The app creates the `Database` instance once at bootstrap from `DATABASE_URL` and passes it into services/dal (injected, not imported as a global) so the dal stays pure and testable.

```ts
// modules/work-items/dal/work-items.dal.ts
import { schema, type Database } from '@devflow/database';
import { eq } from 'drizzle-orm';

export function findWorkItem(db: Database, id: string) {
  return db.query.workItems.findFirst({ where: eq(schema.workItems.id, id) });
}
```

Why schema + migrations are centralized (not per-module): migrations need a single ordered history and one `drizzle-kit` config, and cross-domain foreign keys need one schema graph. Query logic stays in the module so modules remain cohesive and the dal remains swappable.

### File naming convention

- Route layer (folder gives context): `routes/v<n>/<module>/router.ts` + `schema.ts`.
- Module layers (prefixed for searchability): `modules/<module>/service/<module>.service.ts`, `modules/<module>/dal/<module>.dal.ts`.

### Deeper module layering (optional)

`health` is intentionally lightweight. A domain-heavy module (e.g. `work-items`) may add sub-layers under the module — e.g. a `domain/` folder for the state machine and value objects, and `events/` for domain-event publishers — but it still exposes only its **service** to the route layer and reaches Postgres only through its **dal**.

Business logic depends on **ports**, never vendor SDKs (§3, §8).

## Getting started

```bash
docker compose up -d postgres redis   # from repo root — local Postgres + Redis
pnpm install                          # from repo root
cp apps/api/.env.example apps/api/.env
pnpm --filter @devflow/api dev
```

On boot, the app connects to Postgres + Redis and runs pending migrations
automatically (see [`docs/orchestration.md`](docs/orchestration.md) §2).

- API: `http://localhost:4000`
- Health: `GET http://localhost:4000/api/v1/health`
- **API docs (Scalar):** `http://localhost:4000/doc`
- OpenAPI JSON: `http://localhost:4000/openapi.json`

## Scripts

| Script      | Purpose                      |
| ----------- | ---------------------------- |
| `dev`       | Watch mode (`tsx`)           |
| `build`     | Bundle to `dist/` (`tsup`)   |
| `start`     | Run built server             |
| `typecheck` | `tsc --noEmit`               |
| `test`      | Run Vitest                   |
| `clean`     | Remove `dist/` and `.turbo/` |

## Environment

| Var            | Default      | Notes                                                    |
| -------------- | ------------ | -------------------------------------------------------- |
| `NODE_ENV`     | development  | `development` enables pretty logs                        |
| `HOST`         | 0.0.0.0      |                                                          |
| `PORT`         | 4000         |                                                          |
| `LOG_LEVEL`    | info         | pino levels (`silent` allowed)                           |
| `DATABASE_URL` | _(required)_ | e.g. `postgres://devflow:devflow@localhost:5433/devflow` |
| `REDIS_URL`    | _(required)_ | e.g. `redis://localhost:6379`                            |

## Adding a module

1. If the module needs tables, add them to the `packages/database` schema and generate a migration (`pnpm --filter @devflow/database db:generate`).
2. Create the business layers under `src/modules/<name>/`: `service/<name>.service.ts` and `dal/<name>.dal.ts` (the dal imports the client + schema from `@devflow/database`).
3. Create the HTTP layer under `src/routes/v1/<name>/`: `router.ts` and `schema.ts`.
4. Register the router in `src/routes/v1/index.ts`.
5. Add tests under the module's `__tests__/`.
6. If the module publishes domain events, also follow [`docs/orchestration.md`](docs/orchestration.md) §4 ("Adding a real event-driven flow") to add its `events`, `jobs`, `routing`, and relay wiring.

See [`docs/api-docs-and-testing.md`](docs/api-docs-and-testing.md) for the API
documentation and testing conventions (required route fields, tags, and the
minimal/critical test checklist).
