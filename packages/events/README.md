# @devflow/events

Domain-event contracts and the transactional-outbox relay for the DevFlow
monorepo (see [`project.md`](../../project.md) §9, §10). This is where
`PostgreSQL (outbox_events) → relay → @devflow/queue (BullMQ) → workers`
actually connects.

**Not event sourcing.** PostgreSQL domain state remains authoritative; the
outbox is a **durable publication log**, not the system of record. Consumers
never rebuild state by replaying events.

## Design

- **Owns the envelope, not the transport.** Defines `DomainEvent` + the outbox contract; publishes onto **`@devflow/queue`** job definitions — it does not reimplement queuing.
- **Owns the outbox table shape, not general database access.** Defines the `outbox_events` schema contract that `@devflow/database` migrations implement; imports nothing else from that package.
- **At-least-once publication, not exactly-once.** A relay crash or lease expiry can cause the same event to be enqueued more than once. This is consistent with `@devflow/queue`'s own at-least-once contract — every event carries a stable `id` so downstream consumers dedupe.
- **Durable history vs. projections are different things** (§9). This package produces the durable event log. **Activity** (persisted timeline) and **Audit** (immutable record) are separate consumers of these events — not implemented here.

## Folder structure

```text
packages/events/
├── src/
│   ├── index.ts          # public exports
│   ├── event.ts          # DomainEvent envelope + defineEvent()
│   ├── outbox.ts         # outbox row contract + publishOutbox() (same-tx write)
│   ├── routing.ts        # defineRoute() — event type → queue/job mapping
│   ├── relay.ts          # relayOutbox() — claim/lease → publish → mark relayed
│   └── __tests__/
├── package.json
├── tsconfig.json
└── README.md
```

## Public API

| Export                  | Purpose                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `defineEvent(def)`      | Declare a typed event definition: `{ type, schema, schemaVersion }` → `.create(input)` |
| `DomainEvent<T,P>`      | The envelope type (see below)                                                          |
| `publishOutbox(tx, ev)` | Write an event row **within the caller's DB transaction** (no queue I/O)               |
| `defineRoute(def)`      | Map an event definition to a `@devflow/queue` job (event → queue/job)                  |
| `relayOutboxOnce(opts)` | One claim → publish-via-routes → mark-relayed cycle (call it on an interval/loop)      |

## Contracts

### `DomainEvent` envelope

```ts
type EventId = string; // globally unique id, format-agnostic (UUID/ULID)
type CorrelationId = string;
type CausationId = string;

interface DomainEvent<Type extends string = string, Payload = unknown> {
  id: EventId; // assigned once at creation — never regenerated on retry
  type: Type;

  organizationId: string;
  aggregateId: string;

  correlationId: CorrelationId; // threads webhook → job → API → event → notification
  causationId?: CausationId; // id of the event/action that caused this one

  occurredAt: string; // ISO 8601

  schemaVersion: number; // payload/contract version for `type`
  aggregateVersion?: number; // monotonic revision of the aggregate; required when the event definition declares `ordering: 'aggregate'`

  payload: Payload;
}
```

`schemaVersion` and `aggregateVersion` are deliberately separate: the former is "did the payload contract change," the latter is "what revision of the aggregate is this" (used for ordering, see below).

### `defineEvent` — typed definition, not a bare object

```ts
const WorkStarted = defineEvent({
  type: 'work-item.started',
  schemaVersion: 1,
  schema: WorkItemStartedPayloadSchema,
  ordering: 'aggregate', // 'aggregate' requires aggregateVersion on every .create(); 'none' (default) does not
});

const event = WorkStarted.create({
  organizationId,
  aggregateId,
  correlationId,
  aggregateVersion,
  payload,
});
```

`defineEvent` gives one canonical event name, runtime payload validation, and type inference; `.create()` stamps `id`, `occurredAt`, and `schemaVersion` consistently, and enforces `aggregateVersion` when `ordering: 'aggregate'` is declared.

**Schema-version compatibility:** each definition's consumers declare which `schemaVersion`s they understand. A worker receiving an event version it doesn't support fails explicitly (routed to the dead-letter queue, never silently coerced) rather than guessing at a migration. Version-to-version payload migration, where needed, is the consumer's explicit responsibility, not automatic in this package.

**Event registry (future):** as the number of event definitions grows, a registry mapping `type → definition → schema → route` lets the relay validate that a persisted outbox row is understood by the currently deployed code before publishing. Not required for the first implementation, but the API should not preclude adding one.

### Event naming convention

`<subject>.<past-tense-action>`, lowercase kebab-case — never mix with `SCREAMING_SNAKE` or `PascalCase`:

```text
work-item.created         work-item.started
branch.created            pull-request.created
ai-review.requested       ai-review.completed
pull-request.approved     pull-request.merged
deployment.started        deployment.succeeded / .failed
```

### `outbox_events` contract (implemented in `@devflow/database`)

```text
outbox_events
  id               uuid primary key      -- = DomainEvent.id
  type             text
  organization_id  uuid
  aggregate_id     uuid
  correlation_id   uuid
  causation_id     uuid null
  payload          jsonb
  schema_version   int
  aggregate_version int null
  occurred_at      timestamptz
  created_at       timestamptz default now()

  -- relay/claim bookkeeping (relay attempts only — worker/job retry counts live in BullMQ, not here)
  claimed_at       timestamptz null
  claimed_by       text null             -- relay instance id, for lease diagnostics
  claim_expires_at timestamptz null      -- explicit lease expiry; reclaim when now() > this
  relayed_at       timestamptz null      -- set once successfully enqueued (i.e. handed to the queue —
                                          -- NOT "every consumer finished processing it"; consumers
                                          -- own their own downstream processing state)
  attempts         int default 0        -- number of relay publish attempts
  last_error       text null
```

`outbox_events` intentionally combines event data with relay operational state for now (fine at this scale). If per-consumer delivery tracking is ever needed (Activity/Audit/Slack/Analytics each confirming receipt independently), that becomes a separate `outbox_deliveries` table rather than overloading this one — not needed yet.

### Publish (same transaction as the state change)

```ts
await db.transaction(async (tx) => {
  await tx.update(workItems).set({ status: 'merged' }).where(...);
  await publishOutbox(tx, WorkItemMerged.create({ aggregateId, organizationId, correlationId, payload }));
});
```

`publishOutbox` only writes the row — never talks to Redis/BullMQ — preserving "DB commit implies the event exists" (§10). **`publishOutbox` accepts only a transaction-scoped database handle** (the type signature takes the `tx` from `db.transaction(...)`, not the top-level `db`) — calling it outside a transaction is a type error, not just a documented convention.

### Event → queue routing

The relay needs an explicit mapping from event type to a `@devflow/queue` job; this lives in the events/worker layer, **not** inside `@devflow/queue` itself (which stays domain-agnostic):

```ts
defineRoute({ event: AiReviewRequested, job: aiReviewJob });
```

```text
EventRoute
 ├── event definition (type + schema)
 ├── target @devflow/queue job
 └── payload mapping (event.payload → job payload)
```

The queue `jobId` is namespace-scoped per route — `jobId(routeName, event.id)`, e.g. `jobId('ai-review', event.id)` — using `@devflow/queue`'s own `jobId()` helper, not the raw event id. This keeps the same event feeding multiple routes (e.g. an `ai-review` job and an `activity` job from one event) from colliding on a single BullMQ job id.

### Relay: claim/lease, not a held transaction

**Rule: never hold a DB transaction open while calling out to Redis.** The relay claims rows, commits, then publishes:

```text
1. BEGIN; claim a batch via SKIP LOCKED, set claimed_at/claimed_by/claim_expires_at; COMMIT.
2. For each claimed row: enqueue via the matching route, jobId = jobId(routeName, event.id).
3. On success: mark relayed_at (separate, short transaction).
4. On failure: increment attempts, record last_error; leave relayed_at null.
5. A row whose claim_expires_at has passed and relayed_at is still null is
   eligible for another relay instance to reclaim.
```

This is an **at-least-once** guarantee, not exactly-once: a relay that crashes between step 2 and step 3 leaves a claimed-but-unrelayed row, which another instance retries after the lease expires — enqueuing the event again. **The deterministic `jobId` is enqueue-time deduplication, not a permanent correctness guarantee** — once a completed job is removed from BullMQ (`removeOnComplete`), a later retry can create a new job with the same id. Actual correctness comes from `jobId` dedup **plus** idempotent consumers together, not either alone; this package does not attempt exactly-once delivery.

### Ordering

**Ordering is opt-in, per event definition** (`ordering: 'aggregate' | 'none'`, default `'none'`) — most consumers (e.g. Slack notifications) don't need it and shouldn't be burdened with version-checking. For `ordering: 'aggregate'` events, a consumer that receives an event older than its last-processed `aggregateVersion` **ignores it** (does not requeue); an event newer than expected is retried later with bounded backoff, not requeued immediately, to avoid a tight retry loop while an earlier event is still in flight.

## Non-goals

- No Activity/Audit projection logic (separate consumers, §9).
- No provider-specific event types (those live in `packages/integrations`).
- No direct Redis/BullMQ API usage outside `relay.ts` — everything else imports `@devflow/queue`.
- Not an event-sourcing framework — see the note at the top.

## Scripts

| Script      | Purpose                |
| ----------- | ---------------------- |
| `typecheck` | `tsc --noEmit`         |
| `test`      | Run Vitest             |
| `clean`     | Remove build artifacts |

> Implemented: `event.ts` (`defineEvent`), `outbox.ts` (`publishOutbox`), `routing.ts` (`defineRoute`), `relay.ts` (`relayOutboxOnce`). The relay's claim/publish/mark-relayed cycle is unit-tested at the routing/event layer; wiring it into a running worker loop (interval or queue-scheduled) is done by the consuming app.

## Package relationships

|                 |                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Depends on**  | `@devflow/database` (`DatabaseTransaction` type, `schema.outboxEvents`); `@devflow/queue` (`JobHandle`, `jobId`)                                                                                                                |
| **Consumed by** | `apps/api` (`publishOutbox` inside service transactions, `relayOutboxOnce` on an interval, `defineRoute` wiring event → job) — see [`apps/api/docs/orchestration.md`](../../apps/api/docs/orchestration.md) for the full wiring |
