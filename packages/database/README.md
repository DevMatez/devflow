# @devflow/database

PostgreSQL access for the DevFlow monorepo — **Drizzle ORM**, schema, and
migrations (see [`project.md`](../../project.md) §4, §9, §10). Consumed by
`apps/api` / `apps/worker`; also defines the `outbox_events` and
`webhook_events` table contracts that `@devflow/events` and the integration
webhook route depend on.

## Design

- **Options-in, no env reads:** `createDatabase(connectionString)` takes the
  connection string as a parameter — the host app reads `DATABASE_URL` (via
  `@devflow/config`) and passes it in. This package never reads `process.env`.
- **One pool per process.** Call `createDatabase` **once** per app process
  (`apps/api`, `apps/worker` each create their own single instance) and pass
  the resulting `Database` into modules — never construct multiple pools in
  one process. Call `closeDatabase(db)` on shutdown (`SIGTERM` → stop
  accepting work → finish/abort in-flight jobs → `closeDatabase` → exit).
- **Owns schema + migrations, not query logic.** Module `dal`s (e.g.
  `apps/api/src/modules/work-items/dal`) import the shared client + schema
  from here and write their own queries — this package does not contain
  per-module business queries (§7 in `apps/api/README.md`). **Table
  visibility does not imply ownership**: the schema barrel is intentionally
  broad for convenience, but a module querying another module's tables
  directly is a boundary violation, enforced by code review/lint, not by the
  package.
- **PostgreSQL is authoritative for DevFlow orchestration state** (§9); this
  package is the only place that talks to it directly.
- **Transactions are first-class and typed.** `db.transaction(async (tx) => { ... })`
  is the required pattern for any write that must also publish a domain
  event. The package exports a precise `DatabaseTransaction` type (not a
  generic client) so `publishOutbox(tx: DatabaseTransaction, event)` can only
  ever be called with a transaction-scoped handle, never the top-level `db`.
- **Default transaction isolation.** Reads/writes use Postgres's default
  isolation level unless a specific module explicitly documents and
  implements a stronger requirement (e.g. row locking or a uniqueness
  constraint for a race like competing `StartWork` requests) — no global
  `SERIALIZABLE` without a concrete, documented reason.
- **No dependency on `@devflow/events`.** `@devflow/events` defines the
  outbox/event _contract_ and depends on this package's `DatabaseTransaction`
  type; this package must never import `@devflow/events` — that would create
  a circular package dependency. The dependency graph is one-way:

  ```text
  @devflow/database  (schema, DatabaseTransaction type)
         │
         ▼
  @devflow/events    (outbox contract, relay — depends on database)
         │
         ▼
  @devflow/queue
  ```

  `publishOutbox` is called from **application code** that imports both
  packages — never from inside `@devflow/database` itself.

## Package relationships

|                 |                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Depends on**  | _(none)_ — zero internal `@devflow/*` dependencies (Drizzle ORM + `postgres` driver only)                                                                  |
| **Consumed by** | `@devflow/events` (`DatabaseTransaction` type, `schema.outboxEvents`); `apps/api` (creates the process's one `Database` instance, runs migrations at boot) |

## Schema conventions (tenant-owned tables)

Every tenant-owned domain table:

- `organization_id uuid not null references organizations(id)` (FK — structural
  isolation at the database level; authorization is still enforced in
  application code, this is a second layer, not a replacement).
- An index on `organization_id`, plus tenant-aware composite indexes matching
  real access patterns (e.g. `(organization_id, status)`,
  `(organization_id, created_at)`) — added when a query pattern needs them,
  not speculatively on every table.

Infrastructure tables (`outbox_events`, `webhook_events`) are exceptions where
noted in their own contract below.

**Schema classification (conceptual, not yet a folder split):** as the schema
grows, think of tables as _core domain_ (work items, projects, ...),
_integration infrastructure_ (per-provider config), or _async infrastructure_
(`outbox_events`, `webhook_events`). The current flat `schema/` folder is
fine for the MVP; revisit a `core/ integrations/ infrastructure/` split only
when the flat list becomes hard to navigate.

## Folder structure

```text
packages/database/
├── src/
│   ├── index.ts          # public exports
│   ├── client.ts          # createDatabase(connectionString) → Drizzle instance
│   └── schema/
│       ├── index.ts       # barrel — re-exports every table
│       ├── organizations.ts   # tenancy root
│       ├── outbox-events.ts   # contract required by @devflow/events
│       └── webhook-events.ts  # inbound webhook idempotency (§10)
├── drizzle/               # generated SQL migrations (drizzle-kit)
├── drizzle.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

## Public API

| Export                | Purpose                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `createDatabase(url)` | Returns a Drizzle instance bound to the given connection string                         |
| `closeDatabase(db)`   | Closes the underlying connection pool (graceful shutdown)                               |
| `runMigrations(db)`   | Applies pending migrations (call once at process boot; resolves its own migrations dir) |
| `schema`              | Every table definition, namespaced (`schema.organizations`, `schema.outboxEvents`, ...) |
| `Database`            | The type of the value `createDatabase` returns                                          |
| `DatabaseTransaction` | The transaction-scoped handle type passed to `db.transaction(async (tx) => ...)`        |

## Schema contracts

### `outbox_events` — required by `@devflow/events`

Matches the contract in `packages/events/README.md` exactly (claim/lease
fields included):

```text
outbox_events
  id                uuid primary key
  type              text
  organization_id   uuid
  aggregate_id      uuid
  correlation_id    uuid
  causation_id      uuid null
  payload           jsonb
  schema_version    int
  aggregate_version int null
  occurred_at       timestamptz
  created_at        timestamptz default now()
  claimed_at        timestamptz null
  claimed_by        text null
  claim_expires_at  timestamptz null
  relayed_at        timestamptz null
  attempts          int default 0
  last_error        text null

  -- partial index supporting the relay's claim query
  index (occurred_at) where relayed_at is null
```

The relay's claim query is always `WHERE relayed_at IS NULL AND (claim_expires_at
IS NULL OR claim_expires_at < now())`; the partial index above keeps that scan
cheap as the table grows instead of degrading into a full-table scan.

### `webhook_events` — inbound idempotency (§10)

```text
webhook_events
  id                     uuid primary key
  provider               text                 -- 'github' | 'slack' | 'plane' | ...
  provider_delivery_id   text                 -- GitHub X-GitHub-Delivery, Plane event_id, ...
  organization_id        uuid null            -- see note below
  event_type             text
  payload                jsonb
  received_at            timestamptz default now()
  processing_started_at  timestamptz null
  processing_attempts    int default 0
  last_error             text null
  processed_at           timestamptz null

  unique (provider, provider_delivery_id)
```

- **`organization_id` is nullable.** The webhook route persists the raw event
  _before_ it can always resolve `installation → organization` (unknown
  installation, revoked OAuth, misconfiguration). The row is attached to an
  organization once resolved; a permanently-unresolved row stays available
  for debugging rather than being dropped.
- **`processed_at IS NULL` alone is ambiguous** — it means either "not yet
  processed" or "processing failed." `processing_started_at`,
  `processing_attempts`, and `last_error` disambiguate without needing a
  separate status column yet.
- **Payload retention:** the full JSONB payload is stored for MVP (debugging
  and replay value outweighs storage cost at this scale). Add a retention
  policy (e.g. 30–90 days) before this becomes an unbounded-growth table in
  production; not required for MVP.

**Safe insert sequence** (a crash after receiving the webhook must not lose
it): `verify signature → INSERT webhook_events → commit → queue processing →
return 2xx`. The route does `INSERT ... ON CONFLICT (provider,
provider_delivery_id) DO NOTHING` — a duplicate delivery is a no-op **only**
because the original was durably committed first.

### `organizations` — tenancy root

Every other domain table is scoped by `organization_id`; `organizations` is
the first table so that foreign keys have somewhere to point.

## Usage

```ts
import { createDatabase, schema } from '@devflow/database';
import { eq } from 'drizzle-orm';

const db = createDatabase(env.DATABASE_URL); // once per process

// simple read
const org = await db.query.organizations.findFirst({
  where: eq(schema.organizations.id, orgId),
});

// write + outbox in one transaction — application code imports both packages;
// @devflow/database itself never imports @devflow/events (see Design above)
import { publishOutbox } from '@devflow/events';

await db.transaction(async (tx) => {
  await tx.update(schema.workItems).set({ status: 'merged' }).where(eq(schema.workItems.id, id));
  await publishOutbox(tx, WorkItemMerged.create({ ... }));
});
```

## Local development

Postgres (and Redis, for `@devflow/queue`) run via the root
[`docker-compose.yml`](../../docker-compose.yml):

```bash
docker compose up -d postgres
cp packages/database/.env.example packages/database/.env   # DATABASE_URL
```

Default connection matches the compose service:
`postgres://devflow:devflow@localhost:5433/devflow` (mapped to host port 5433
to avoid clashing with any other local Postgres on 5432).

## Migrations

```bash
pnpm --filter @devflow/database db:generate   # generate SQL from schema changes
pnpm --filter @devflow/database db:migrate    # apply pending migrations
pnpm --filter @devflow/database db:push       # LOCAL DEVELOPMENT ONLY
pnpm --filter @devflow/database db:studio     # Drizzle Studio
```

Migrations are the **single ordered history** for the whole schema (§9) — no
per-module migration folders.

- **`db:push` is local-development only — never CI, never staging/production.**
  Schema changes in any shared environment always go through a committed,
  generated migration.
- **Migration transactionality:** migrations run inside a transaction when
  Postgres supports the change atomically; any migration that cannot be
  (e.g. certain concurrent index builds) must be explicitly called out in its
  own migration/PR description, not silently assumed safe.

## Scripts

| Script      | Purpose                |
| ----------- | ---------------------- |
| `typecheck` | `tsc --noEmit`         |
| `clean`     | Remove build artifacts |
