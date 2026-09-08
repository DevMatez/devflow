# Phase 1 — MVP Build Plan

**Status:** Planning
**Scope source:** `project.md` §13 (Roadmap — MVP)
**Goal:** Ship the core end-to-end workflow — _ticket → start work → branch → PR → AI review → merge → notify → activity_ — for a single provider per integration category (**Plane, GitHub, Slack, Google Calendar**), on the modular-monolith architecture defined in `project.md`.

This document breaks the MVP into buildable modules, groups them into dependency-ordered **waves**, and gives each module a purpose, its dependencies, the `project.md` sections it implements, and a "done when" checklist.

---

## 1. Phase 1 objective

> A developer can connect their org's tools, create a ticket, start work, get an auto-created branch and PR, receive an AI review enforced as a GitHub check, merge, and see the whole thing on an activity timeline — with Slack notifications and calendar visibility.

Phase 1 is deliberately **one adapter per category**. The provider framework (§8) is built now so adding Jira/GitLab/Teams later is additive, but no second adapter ships in Phase 1.

### Guiding constraints (from `project.md`)

- **Modular monolith** — one `apps/api` + `apps/worker`, clear module boundaries (§3, §7).
- **Ports & adapters** — business logic depends on ports, never vendor SDKs (§3, §8).
- **External systems stay authoritative** — reconcile, don't assume (§3, §9).
- **Idempotent integrations** — every webhook/job safe to retry (§3, §10).
- **AI is an assistant** — reviewable, gated, never silently destructive (§3, §11).

---

## 2. Module map at a glance

```text
Wave 0  Foundation ......... monorepo, config, db, events, queue, observability
Wave 1  Identity & Tenancy . auth, organizations, projects
Wave 2  Integration Layer .. provider framework + GitHub/Plane/Slack/Calendar adapters + webhooks
Wave 3  Core Domain ........ work items, dev workflow, activity timeline
Wave 4  AI ................. AI provider, ticket generation, PR review pipeline + check gating
Wave 5  Frontend ........... web shell, dashboard, work items, PR review, integrations settings
```

Waves are dependency-ordered. Within a wave, modules can largely be built in parallel.

---

## 3. Wave 0 — Foundation

Platform scaffolding everything else imports. No product features here.

| Module                                       | Purpose                                                                                   | Implements | Depends on             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------- | ---------------------- |
| **Monorepo & tooling**                       | pnpm workspaces, Turborepo, ESLint/Prettier/TS configs, Docker for local Postgres + Redis | §6         | —                      |
| **`packages/config`**                        | Typed env loading + runtime config                                                        | §6         | monorepo               |
| **`packages/database`**                      | Postgres + Drizzle, migrations, base schema                                               | §10        | config                 |
| **`packages/types` / `packages/validation`** | Shared domain types + Zod schemas                                                         | §6         | —                      |
| **`packages/events`**                        | Domain event contracts + transactional-outbox relay                                       | §10        | types, database, queue |
| **`packages/queue`**                         | BullMQ setup, retry/backoff/idempotency conventions                                       | §10        | config, database       |
| **`packages/observability`**                 | OpenTelemetry + Pino, correlation IDs                                                     | §11        | config                 |

**Done when:** `apps/api` boots, connects to Postgres + Redis, emits a structured log with a correlation ID, runs a migration, and enqueues + processes a no-op job via the outbox relay (event written in a DB tx → relayed to BullMQ → consumed).

---

## 4. Wave 1 — Identity & Tenancy

Multi-tenant foundation. Everything downstream is scoped by `organization_id`.

| Module                | Purpose                                                                                            | Implements | Depends on    |
| --------------------- | -------------------------------------------------------------------------------------------------- | ---------- | ------------- |
| **Identity & Access** | Auth (OAuth/OIDC login), sessions (HTTP-only), users, RBAC (Owner/Admin/Developer/Reviewer/Viewer) | §9, §11    | Wave 0        |
| **Organizations**     | Orgs, teams, members, invitations                                                                  | §9         | Identity      |
| **Projects**          | Projects, repositories link, workflow config (branch naming, PR conventions, review policy)        | §9         | Organizations |

**Key decisions locked here**

- Org-scoping enforced structurally (a repository/service client that can't be built without an org id), not per-handler (§11).
- RBAC checked on every protected action (§11).

**Done when:** a user can sign up, create an org, invite a member with a role, create a project with a workflow config, and all reads/writes are org-scoped.

---

## 5. Wave 2 — Integration Layer

The heart of the platform's swappability. Build the framework first, then the four adapters against it.

| Module                                       | Purpose                                                                                                         | Implements | Depends on       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- | ---------------- |
| **Provider framework (`integrations/core`)** | Category ports, runtime registry, capability descriptors, normalized models, webhook verify+normalize contracts | §8         | Wave 1           |
| **Webhook ingestion**                        | Generic route: verify → persist `webhook_events` (idempotent) → normalize → queue                               | §8, §10    | framework, queue |
| **GitHub adapter**                           | `SourceControlProvider`: branches, PRs, comments, diffs, **check runs** (GitHub App auth)                       | §8, §11    | framework        |
| **Plane adapter**                            | `ProjectManagementProvider`: issue CRUD, comments, inbound webhooks (`event_id` dedupe)                         | §8         | framework        |
| **Slack adapter**                            | `ChatProvider`: workspace connect, channel mapping, notifications                                               | §8         | framework        |
| **Calendar adapter**                         | `CalendarProvider`: Google Calendar events + free/busy                                                          | §8         | framework        |

**Rules enforced (§8)**

- Vendor SDKs only inside their adapter package (lint-enforced).
- Everything crossing a port is a normalized domain model.
- Per-provider idempotency key: GitHub `X-GitHub-Delivery`, Plane `event_id` (not `delivery_id`).

**Done when:** each provider can be connected via OAuth/app-install, a signed webhook from each is verified, de-duplicated, and normalized into a canonical domain event; adapter contract tests pass (§11).

---

## 6. Wave 3 — Core Domain

The actual product workflow, coordinating the Wave 2 adapters through ports.

| Module                      | Purpose                                                                                               | Implements | Depends on                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ---------- | -------------------------- |
| **Work Items**              | Core aggregate: tickets, status, priority, assignment, dependencies, acceptance criteria, links       | §9         | Wave 1                     |
| **Work Item state machine** | Validated transitions `BACKLOG→…→DONE` **+ reconciliation jumps** for out-of-band GitHub changes      | §9         | Work Items                 |
| **Development Workflow**    | Orchestrates: start work → create branch → link branch → create PR (via `SourceControlProvider` port) | §9         | Work Items, GitHub adapter |
| **PR status sync**          | Inbound GitHub webhooks reconcile PR/branch state to work item; anomalies logged, not forced          | §9         | Work Items, webhooks       |
| **Activity timeline**       | Correlated event log surfaced per work item, incl. reconciliation anomalies                           | §9         | events                     |

> The Development Workflow module's public interface (`startWork()`, `createBranch()`, …) stays stable regardless of execution engine — durable execution (Temporal/Inngest) is a later evaluation, not Phase 1. Phase 1 uses BullMQ chaining.

**Done when:** starting work on a ticket creates a correctly named branch and PR via the GitHub port, the work item advances through its state machine, a PR merged outside the platform is reconciled (not silently forced), and every step lands on the activity timeline.

---

## 7. Wave 4 — AI

| Module                                      | Purpose                                                                                                       | Implements | Depends on                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------- |
| **AI provider abstraction (`packages/ai`)** | `AiProvider` port: `generateText`, `generateStructuredOutput`, `reviewCode`                                   | §9         | Wave 0                                |
| **Ticket AI**                               | Ticket generation / improvement / acceptance criteria                                                         | §9         | AI provider, Work Items               |
| **AI Review Pipeline**                      | On `PR_CREATED`: fetch diff → analyze → persist findings → post GitHub review                                 | §9         | AI provider, GitHub adapter, queue    |
| **AI review as merge gate**                 | Post pending `devflow/ai-review` check on PR open; resolve to success/failure; offer to set branch protection | §3         | AI Review Pipeline, GitHub check runs |

**Guardrails (§11):** repository content treated as untrusted input; structured output validated; AI never merges/deploys/rotates secrets without an explicit authorization boundary.

**Done when:** opening a PR posts a pending check, the AI review completes and updates the check (failure only on `critical`), findings appear in GitHub and the platform, and merge is blocked by branch protection until the check resolves.

---

## 8. Wave 5 — Frontend

Next.js app; feature/module-oriented (§6).

| Module                    | Purpose                                                                       | Implements | Depends on              |
| ------------------------- | ----------------------------------------------------------------------------- | ---------- | ----------------------- |
| **App shell + auth**      | Layout, routing, session, org switcher                                        | §6, §9     | Wave 1 API              |
| **Integrations settings** | Connect/disconnect GitHub, Plane, Slack, Calendar; show capability status     | §8         | Wave 2 API              |
| **Developer dashboard**   | Action-oriented "My Work" (action required / in progress / waiting / shipped) | §9         | Work Items API          |
| **Work items**            | List, detail, create (with AI generation), start work                         | §9         | Work Items, Ticket AI   |
| **PR review experience**  | PR detail: ticket, changes, CI, AI review, human review, merge                | §9         | Dev Workflow, AI Review |
| **Activity timeline UI**  | Per-work-item timeline incl. reconciliation anomalies                         | §9         | Activity API            |
| **Realtime (SSE)**        | Live updates via Redis pub/sub fan-out (`org:{id}:events`)                    | §12        | events                  |

**Done when:** a user completes the full flow in the UI — connect tools → create ticket → start work → see branch/PR → view AI review → merge → see timeline update live.

---

## 9. Suggested build sequence

```text
Wave 0 ─┬─► Wave 1 ─┬─► Wave 2 ─┬─► Wave 3 ─┬─► Wave 4
        │           │           │           │
        └───────────┴───────────┴─────► Wave 5 (starts once Wave 1 API exists,
                                          then tracks each wave's endpoints)
```

- Waves 0→3 are a hard chain (each needs the previous).
- Wave 4 (AI) can start as soon as the GitHub adapter (Wave 2) + Work Items (Wave 3) exist.
- Wave 5 (frontend) begins after Wave 1 and grows wave-by-wave as APIs land.

---

## 10. Cross-cutting concerns (every wave)

| Concern                    | Requirement                                                                                           | Ref |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | --- |
| **Security**               | Signature verification, RBAC on every action, encrypted credentials, least-privilege GitHub App       | §11 |
| **Multi-tenant isolation** | Org-scoping enforced structurally; webhook `installation_id → organization_id` before any data access | §11 |
| **Idempotency**            | Inbound `webhook_events` dedupe; deterministic outbound keys                                          | §10 |
| **Observability**          | Correlation ID threaded webhook → job → API call → event → notification                               | §11 |
| **Testing**                | Unit (domain + state transitions), integration (repos/queues/webhooks), E2E (full flow)               | §11 |

---

## 11. Explicitly out of Phase 1 (deferred)

Per the roadmap (§13):

- Second adapter in any category (Jira, Linear, GitLab, Teams) — framework supports it, but not shipped (§8).
- Repository-aware AI / RAG, technical specs, implementation plans, reviewer recommendation (Phase 2, §13).
- Durable-execution engines (Temporal/Inngest) — later evaluation, not Phase 1.
- Workflow automation builder, release/deploy, feature flags (Phase 3, §13).
- Incident management, advanced analytics (Phase 4, §13).

---

## 12. Definition of done — Phase 1

- [ ] A new user can sign up, create an org, and invite members with roles.
- [ ] GitHub, Plane, Slack, and Google Calendar each connect via the provider framework and pass a signed, de-duplicated, normalized webhook round-trip.
- [ ] A ticket can be created (with AI assistance) and started, producing a correctly named branch and PR.
- [ ] Opening a PR triggers an AI review that posts a GitHub check and blocks merge until resolved.
- [ ] PR/branch changes made outside the platform are reconciled, not silently overwritten.
- [ ] Slack notifications fire on the key workflow events.
- [ ] The full lifecycle is visible on the activity timeline, updating live in the UI.
- [ ] Security, idempotency, observability, and test coverage cross-cutting requirements met (§10 above).
