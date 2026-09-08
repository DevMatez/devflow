# Shared packages

Internal libraries consumed by apps (see [`project.md`](../project.md) §6 and
[`phase-1.md`](../phase-1.md) for the build plan). Each package is its own pnpm
workspace package under `packages/*`, documented in its own `README.md`.

## Wave 0 — Foundation (implemented)

| Package                                      | Purpose                                      | Depends on          |
| -------------------------------------------- | -------------------------------------------- | ------------------- |
| [`config`](./config/README.md)               | Typed env loading (`createEnv`, `sharedEnv`) | _(none)_            |
| [`types`](./types/README.md)                 | Branded ids + canonical enum arrays          | _(none)_            |
| [`validation`](./validation/README.md)       | Zod schemas built from `types`' enums        | `types`             |
| [`observability`](./observability/README.md) | Logging, correlation ids, tracing            | _(none)_            |
| [`database`](./database/README.md)           | Drizzle ORM, schema, migrations              | _(none)_            |
| [`queue`](./queue/README.md)                 | BullMQ job definitions, retry/DLQ            | _(none)_            |
| [`events`](./events/README.md)               | Domain events + transactional outbox relay   | `database`, `queue` |

`ui` (Wave 0, shared frontend components) has not been split out of `apps/web` yet.

## Not yet implemented

| Package                | Purpose                                                            | Wave |
| ---------------------- | ------------------------------------------------------------------ | ---- |
| [`ai`](./ai/README.md) | AI provider port + code-review use case (contract/doc only so far) | 4    |
| `integrations/*`       | Provider adapters (GitHub, Plane, Slack, Calendar)                 | 2    |

## How they fit together

```text
@devflow/types ───▶ @devflow/validation
@devflow/database ─┐
@devflow/queue ─────┼──▶ @devflow/events ──▶ apps/api
@devflow/config ────┤
@devflow/observability ┘
```

`apps/api` is the composition root: it's the only place that imports every
foundation package and wires them together at boot. See
[`apps/api/docs/orchestration.md`](../apps/api/docs/orchestration.md) for the
full boot sequence, request lifecycle, and outbox → relay → queue → worker
walkthrough — that's the doc to read first when onboarding.
