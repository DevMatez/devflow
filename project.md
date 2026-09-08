# DevFlow — Architecture Overview

**Status:** v3 · Architecture & Technical Design
**Scope:** The high-level architecture of the DevFlow platform. This is the **top of a layered documentation tree** (§14) — it stays high-level; detailed designs live in each app, package, and module.

---

## 1. Product

DevFlow is a workflow orchestration layer that sits **above** the tools developers already use — project management, source control, chat, and calendar — and drives one continuous flow:

> **Plan → Start → Code → Review → Merge → Ship**

It does not replace GitHub, Plane, or Slack. It coordinates them so a developer runs the whole lifecycle from a single surface.

**Core loop**

```text
Ticket → AI requirements → Start work → Branch → PR → AI review → Human review → CI → Merge → Notify → Done
```

**Principle:** a developer should manage the development workflow without constantly switching tools.

---

## 2. Goals & Scope

**Vision (end state)**

- One workspace across project management, source control, chat, and calendar.
- AI assistance for tickets, specs, code review, and reviewer suggestions.
- Automated branch/PR lifecycle with review gates enforced at the source system.
- Full work-item lifecycle tracking and team notifications.
- Configurable automation, release/deploy visibility, and analytics.

**Scope is phase-tagged** so vision and delivery never blur (full roadmap in §13):

| Phase   | Delivers                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------- |
| **MVP** | Connect Plane · GitHub · Slack · Calendar; ticket → branch → PR → AI review (gated) → merge → Slack → activity timeline |
| **P2**  | Repository-aware AI, technical specs/plans, smart reviewer recommendation                                               |
| **P3**  | Additional adapters (Jira, Linear, GitLab, Teams), workflow automation, release/deploy                                  |
| **P4**  | Incident management, engineering analytics                                                                              |

**Non-goals (initial):** replace any source tool; build a CI/CD platform, IDE, or generalized automation engine; start with microservices.

---

## 3. Principles

1. **Modular monolith first** — extract services only when metrics demand it.
2. **Provider-agnostic** — every external tool is a swappable adapter behind a port (§8).
3. **Split source of truth** — external systems own their data (PR/branch/CI state, issue fields, chat messages); DevFlow owns orchestration state (workflow, cross-system relationships, AI results, config, activity/audit). See §9.
4. **Reconcile, never overwrite** — external state is never silently overwritten; inbound changes reconcile into DevFlow, DevFlow actions push out through adapters, conflicts resolve to the owning system (§9).
5. **Idempotent integrations** — every webhook and job is safe to retry, inbound and outbound (§10).
6. **Least privilege** — GitHub App and narrowly scoped OAuth.
7. **AI recommends, policy decides** — AI output is schema-validated and fed to a deterministic policy; AI never directly authorizes a merge/deploy or performs destructive actions.
8. **Gates enforced at the source** — a rule like "PR needs AI review" is a GitHub required check, not just a DB flag.

---

## 4. Tech Stack

| Layer    | Choices                                                                           |
| -------- | --------------------------------------------------------------------------------- |
| Frontend | Next.js, React, TypeScript, Tailwind, TanStack Query, Zod, React Hook Form        |
| Backend  | Node.js, TypeScript, Fastify, PostgreSQL, Drizzle, Redis, BullMQ, Zod, Pino, OTel |
| AI       | Provider-agnostic abstraction (`AiProvider` port)                                 |
| Infra    | Docker, Vercel (web), containers + managed services (api/workers), GitHub Actions |
| Testing  | Vitest (unit/integration), Playwright (E2E)                                       |

---

## 5. System Architecture

```text
 External systems                         ┌──────────────┐
 (GitHub · Plane · Slack)  ◄── outbound ──│ API (Fastify)│◄── REST + SSE ──► Next.js Web
        │                    (adapters)   │ Core · Integr│
        └──── webhooks ──────────────────►│ · AI (ports) │
                                          └──────┬───────┘
                    writes state + outbox_events + webhook log (one tx)
                                                 ▼
                          ┌────────────────────────────────────┐
                          │  PostgreSQL (orchestration state)   │
                          └──────────────────┬─────────────────┘
                                              │ outbox relay (SKIP LOCKED)
                                              ▼
                                        ┌──────────┐
                                        │  BullMQ  │──► Workers ──► outbound (adapters)
                                        └──────────┘
```

---

## 6. Monorepo

```text
devflow/
├── apps/       web · api · worker
├── packages/   config · database · types · validation · events · queue ·
│               observability · ui · ai · integrations/*
└── tooling/    eslint · tsconfig
```

pnpm workspaces + Turborepo. Each app and package is independently documented (§14).

---

## 7. Backend Module Pattern

- **Routes are versioned and live outside modules:** `routes/v{n}/<module>/{router,schema}`.
- **Modules hold business + data:** `modules/<module>/{service,dal}`.
- Dependency direction is one-way: **route → service → (dal | ports) → infrastructure** (the service orchestrates both the dal and ports; the dal talks only to the database).
- **Cross-module calls go through a module's public service interface only** — never another module's dal, tables, or a vendor SDK.
- Business logic depends on **ports**, never vendor SDKs.

---

## 8. Integration Provider Framework

The platform's core differentiator: any external tool can be swapped or added without touching business logic.

- **Ports** (one per category) + **adapters** (per vendor) + a **runtime registry** that resolves the right adapter from an org's config.
- **Categories:** SourceControl (GitHub) · ProjectManagement (Plane) · Chat (Slack) · Calendar (Google). AI follows the same port pattern but is **platform-configured, not org-connected** (no OAuth/webhooks/health).
- **Rules:** import ports not SDKs; only normalized domain models cross a port; adapters declare capabilities; each adapter owns its webhook verify + normalize.
- **Resolver, not service locator:** application services depend on the category **port** (`SourceControlPort`, `ProjectManagementPort`, …); the registry only resolves `(category, orgId) → port` at the composition edge — it is not referenced throughout business code.
- **Integration health:** each connection tracks status, last successful sync, last failure, and token/OAuth expiry — surfaced in settings and metrics.
- **Adding a provider** = a new adapter package + config — no core changes.

Detailed contracts and per-provider notes live in `packages/integrations` docs.

---

## 9. Core Domains

| Domain               | Responsibility                                                        |
| -------------------- | --------------------------------------------------------------------- |
| Identity & Access    | Auth, sessions, users, RBAC                                           |
| Organizations        | Orgs, teams, members                                                  |
| Projects             | Projects, repo links, workflow/branch/PR/review policies + config     |
| Work Items           | Core aggregate: state machine + reconciliation against source systems |
| Development Workflow | Orchestrates start-work → branch → PR through ports                   |
| Integrations         | Provider framework + adapters (§8)                                    |
| AI                   | Ticket generation, PR review, (later) repo intelligence               |
| Activity             | Correlated lifecycle timeline, including out-of-band reconciliations  |

Each domain carries its own low-level module doc (§14).

### External state vs DevFlow state

```text
                  ┌──────────────────┐
                  │   External State │
                  │ GitHub · Plane   │
                  │ · Slack          │
                  └────────┬─────────┘
                           │
                      reconciliation
                           │
                           ▼
                  ┌──────────────────┐
                  │  DevFlow State   │
                  │ Workflow state   │
                  │ Relationships    │
                  │ Policies         │
                  │ AI results       │
                  │ Activity         │
                  └──────────────────┘
```

> **External state describes what happened. DevFlow state describes how the development workflow is progressing.**

The two are related but **not necessarily identical** — e.g. a GitHub PR can be `OPEN` while the work item is `BLOCKED` because the AI review failed. Workflow state is derived from external events _plus_ DevFlow policy, never blindly mirrored.

### Source-of-truth ownership

| Owner               | Owns                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub              | PR state, branch state, CI/check state                                                                                                             |
| Plane / PM provider | issue fields, canonical issue status                                                                                                               |
| Slack               | messages                                                                                                                                           |
| **DevFlow**         | work-item ↔ branch ↔ PR relationships, workflow/orchestration state, AI review results, reconciliation state, org/project config, activity & audit |

### Work Item aggregate

`WorkItem` is the core aggregate. It **owns**: external issue reference, workflow state, project, assignee (mirror), branch reference, PR reference, deployment references (P3), and workflow activity. It **does not own** the canonical data behind those references — GitHub owns PR/branch details, the PM provider owns issue fields, Slack owns messages. This keeps the database from becoming a second GitHub/Jira.

**Every work item binds to an external issue.** AI-generated tickets are created in the PM provider (Plane) via the adapter and then bound — DevFlow never stores canonical issue fields for native-only items, so a connected PM provider is required to create work items.

**Assignee rule:** the PM provider holds the canonical assignee; DevFlow's copy is a cached mirror. On divergence, the PM provider wins and the mirror is updated — DevFlow changes an assignee only by writing outbound through the adapter.

The work-item **state machine** (statuses + allowed transitions, including reconciliation jumps) is defined in the work-items module doc, not here.

### Reconciliation & conflict model

Every synchronized entity tracks: `externalId`, last external version/event, last-synced timestamp, local orchestration state, and a conflict policy. Rules:

- External state is **never silently overwritten**; inbound changes reconcile into DevFlow.
- DevFlow workflow actions update the source system through the adapter (outbound).
- Conflicts resolve to the **owning system's authority**; anything ambiguous is recorded in activity and surfaced, never force-applied.

### Activity vs Audit

- **Domain events** — durable internal history (outbox, §10).
- **Activity** — human-facing timeline ("Arjun started PROJ-142", "AI review completed"): a **persisted projection** built from domain events into an `activity` table — not rebuilt from raw events on every read.
- **Audit log** — immutable security/compliance record: `actor, action, resource, before, after, ip, timestamp`.

### AI review gating (deterministic)

```text
repo / issue / PR content → UNTRUSTED CONTEXT → AI review
   → schema-validated output → policy engine → GitHub Check conclusion
```

AI produces severity-tagged findings; a **deterministic policy** maps them to pass/fail (e.g. fail on `critical`/`high`). A raw model score never decides a merge — the GitHub Check is the gate (§3, §8). DevFlow's AI review record is **authoritative for the findings**; the `devflow/ai-review` GitHub Check is a projection of the policy conclusion, re-derivable at any time.

---

## 10. Data & Events

- **PostgreSQL is authoritative** for DevFlow orchestration state (§9); **Redis** is cache, locks, and pub/sub only — never a source of truth.
- **Transactional outbox:** domain events are written to an `outbox_events` table **in the same transaction** as the state change, then relayed to **BullMQ** by an outbox relay that claims rows with `FOR UPDATE SKIP LOCKED` (safe across multiple worker replicas). This prevents lost events when the DB commits but the queue publish fails — BullMQ is the transport, not the durable event store.
- **Delivery semantics:** internal events are **at-least-once** — a consumer can crash after processing but before acknowledging and receive the same event again. Therefore **all consumers must be idempotent**, and every event carries a **stable event ID** for deduplication.
- **Idempotency (two directions):**
  - _Inbound_ — webhooks are de-duplicated in `webhook_events` (per-provider key, e.g. GitHub `X-GitHub-Delivery`, Plane `event_id`).
  - _Outbound_ — each provider operation carries a deterministic idempotency key; where a provider lacks native idempotency (e.g. create branch/PR), the op is persisted first, then on retry the adapter checks whether the resource already exists and reconciles instead of duplicating.
- **Failure handling:** jobs define retry + exponential backoff; exhausted jobs land in a dead-letter queue and raise an alert.

Concrete schemas and event contracts live in `packages/database` and `packages/events` docs.

---

## 11. Cross-Cutting Concerns

- **Security:** webhook signature verification, RBAC on every action, encrypted credentials, GitHub App least privilege. Repository/issue/PR content is **untrusted model context** — sanitized, isolated, and never able to authorize actions (§9).
- **Multi-tenancy:** org-scoping enforced structurally; webhooks resolve `installation → organization` before any data access.
- **Observability:** a correlation ID threads webhook → job → API call → event → notification.
- **Testing:** unit (domain/state) · integration (repos/queues/webhooks) · E2E (full flow).

---

## 12. Scalability

- Stateless **API + workers scale horizontally**. Baseline is a **single PostgreSQL primary** with proper indexes + connection pooling; **read replicas are added only when measured read load requires them** — latency-sensitive workflow reads (create PR → see it immediately) stay strongly consistent.
- **Realtime via SSE + Redis pub/sub fan-out** across API instances. SSE carries **ephemeral UI updates, not durable events**: on reconnect the client refetches current state, then resumes the stream. Redis pub/sub is never the durable event mechanism (that is the outbox, §10).
- Extract independent services (AI, repository indexing, webhook ingestion) **only when metrics demand it** — each has a defined trigger in the scalability notes.
- **Known deferral (recorded, not built):** per-org queue fairness / rate-limiting so one tenant can't starve others — added when a tenant's volume warrants it.

---

## 13. Roadmap

- **MVP:** auth · org · connect Plane/GitHub/Slack/Calendar via the provider framework · work items · AI ticket generation · start work · branch + PR · AI PR review enforced as a GitHub check · CI/check status on the PR view · reconciliation of out-of-band changes · Slack notifications · activity timeline.
- **Phase 2:** repository-aware AI, specs/plans/test-plans, smart reviewer recommendation.
- **Phase 3:** Jira/Linear/GitLab/Teams adapters, workflow automation, release/deploy, feature flags.
- **Phase 4:** incident management, org-wide analytics.

---

## 14. Documentation Model

Documentation is **layered and lives next to the code**. Each level links up to its parent and down to its children.

```text
project.md                     ← high-level architecture & product (this document)
├── apps/<app>/README.md       ← app purpose, structure, how to run, conventions
│   └── modules/<m>/*          ← low-level module docs: responsibilities, domain, API, events, decisions
└── packages/<pkg>/README.md   ← package purpose, public API, usage, conventions
```

- **`project.md`** stays high-level — it never absorbs module detail.
- **Every app and package** carries its own README/docs.
- **Apps are divided into modules**, and **each module owns a low-level doc**.
- We work **top-down**: solidify this document first, then flesh out app/package docs, then module docs — reviewing at each level before moving down.

---

## 15. Key Architectural Decisions

| Decision              | Choice                              | Why                                                                                                                    |
| --------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Backend architecture  | Modular monolith                    | Speed + clear boundaries; avoid premature microservices                                                                |
| Language              | TypeScript everywhere               | Shared types across the stack                                                                                          |
| HTTP framework        | Fastify                             | Lightweight, typed, integration-friendly                                                                               |
| Database / ORM        | PostgreSQL + Drizzle                | Relational workflow data with end-to-end type inference                                                                |
| Cache / jobs          | Redis + BullMQ                      | Fast state + async transport (durability via outbox, §10)                                                              |
| Async events          | Transactional outbox → BullMQ       | No lost events when DB commits but publish fails                                                                       |
| Source of truth       | Split: external vs DevFlow (§9)     | External systems own their data; DevFlow owns orchestration                                                            |
| Integration model     | Ports & adapters + runtime registry | Swap/add any tool without touching business logic                                                                      |
| Integration set (MVP) | Plane · GitHub · Slack · Calendar   | One adapter per category; Calendar MVP scope is connect + surface work-item due dates as events (richer scheduling P2) |
| Source control auth   | GitHub App                          | Scoped per-org permissions + Checks API                                                                                |
| AI                    | Provider abstraction (`AiProvider`) | Avoid AI vendor lock-in                                                                                                |
| AI review gating      | AI findings → policy → GitHub Check | Deterministic gate; AI recommends, policy decides                                                                      |
| Realtime              | SSE + Redis pub/sub                 | Ephemeral UI updates; resync on reconnect (§12)                                                                        |
| API                   | REST, versioned (`/api/v{n}`)       | Simple, explicit, evolvable                                                                                            |
