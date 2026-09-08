# `@devflow/web` — Next.js frontend

**Wave:** 5 (Frontend) · **Status:** Scaffold  
**Architecture refs:** `project.md` §4, §6, §9 · `phase-1.md` §8

The web app is the developer workflow surface: connect tools, manage tickets, start work, review PRs, and follow the activity timeline. It is a **feature-module-oriented** Next.js App Router application inside the Devflow pnpm monorepo.

---

## Stack

Aligned with `project.md` §4 (Tech Stack):

| Technology          | Role in this app                                             |
| ------------------- | ------------------------------------------------------------ |
| **Next.js 16**      | App Router, SSR/SSG, routing, bundling (Turbopack in dev)    |
| **React 19**        | UI runtime                                                   |
| **TypeScript**      | Strict typing via `@devflow/tsconfig`                        |
| **Tailwind CSS 4**  | Utility-first styling (`@tailwindcss/postcss`)               |
| **TanStack Query**  | Server-state, caching, background refetch                    |
| **Zod**             | Runtime validation (forms + API boundaries)                  |
| **React Hook Form** | Complex forms (integrations, work items)                     |
| **Motion**          | UI transitions (`motion` package)                            |
| **Vitest**          | Unit and component tests                                     |
| **Playwright**      | End-to-end tests                                             |
| **ESLint**          | `@devflow/eslint-config/next` (core-web-vitals + TypeScript) |

---

## How it fits the monorepo

```text
devflow/
├── apps/web/          ← this package (@devflow/web)
├── apps/api/          ← Fastify API (Waves 1–4)
├── apps/worker/       ← BullMQ workers (Waves 2–4)
├── packages/          ← shared types, validation, ui, …
└── tooling/
    ├── eslint/        ← @devflow/eslint-config
    └── typescript/    ← @devflow/tsconfig
```

- **Workspace name:** `@devflow/web`
- **Import alias:** `@/*` → project root of `apps/web`
- **API base URL:** `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`)

The frontend never imports vendor SDKs (GitHub, Slack, etc.). It talks to `apps/api` over REST; the API owns integrations via ports & adapters (`project.md` §8).

---

## Directory structure

Feature-oriented layout (`project.md` §6) — routes compose modules; business logic stays out of generic UI primitives.

```text
apps/web/
├── app/                    # Next.js App Router — URLs and layouts only
│   ├── layout.tsx          # Root layout, metadata, global providers
│   ├── page.tsx            # Marketing / landing (/)
│   ├── globals.css         # Tailwind + CSS variables
│   ├── (auth)/             # Unauthenticated routes (no dashboard chrome)
│   │   ├── layout.tsx
│   │   └── login/
│   └── (dashboard)/        # Authenticated shell (shared nav)
│       ├── layout.tsx
│       ├── dashboard/      # /dashboard — My Work (§9)
│       ├── work-items/     # /work-items
│       ├── projects/       # /projects
│       ├── reviews/        # /reviews
│       ├── integrations/   # /integrations
│       └── settings/       # /settings
│
├── modules/                # Feature modules (§6) — hooks, queries, feature UI
│   ├── dashboard/
│   ├── work-items/
│   ├── projects/
│   ├── reviews/
│   ├── integrations/
│   ├── activity/
│   └── notifications/
│
├── components/
│   ├── ui/                 # Design-system primitives (or re-export packages/ui)
│   └── layout/             # App shell, nav, page headers
│
├── lib/
│   ├── api/                # API client, typed fetch helpers
│   ├── auth/               # Session helpers (Wave 1)
│   ├── validation/         # Client Zod schemas (mirror packages/validation)
│   ├── providers/          # React context providers (Query, etc.)
│   └── utils/              # Shared utilities (e.g. cn)
│
├── tests/
│   ├── setup.ts            # Vitest + Testing Library
│   └── e2e/                # Playwright specs
│
├── public/                 # Static assets
├── eslint.config.mjs       # Extends @devflow/eslint-config/next
├── tsconfig.json           # Extends @devflow/tsconfig/nextjs.json
├── vitest.config.ts
├── playwright.config.ts
└── next.config.ts
```

### Layering rules

1. **`app/`** — routing, layouts, page entrypoints. Pages should be thin; import from `modules/`.
2. **`modules/`** — product features. Each module owns its TanStack Query keys, hooks, and feature components. Avoid cross-module imports except through explicit module APIs.
3. **`components/ui`** — presentational primitives with no domain knowledge.
4. **`components/layout`** — app chrome shared across dashboard routes.
5. **`lib/`** — cross-cutting utilities with no UI. No business rules that belong in `modules/`.

This keeps business logic in `modules/`, not in generic UI primitives.

---

## Runtime architecture

```text
 Browser
    │
    ▼
 Next.js (apps/web)
    │  TanStack Query  ──► REST ──► apps/api (Fastify)
    │  React Hook Form + Zod
    │  SSE (realtime, §12) ──► live timeline / org events
    ▼
 PostgreSQL / Redis / Workers (authoritative state lives behind API)
```

### Providers

`lib/providers/app-providers.tsx` wraps the tree with:

- **QueryProvider** — TanStack Query client (stale time, refetch defaults)

Additional providers (session, theme, realtime) are added as Wave 1 and realtime (§12) land.

### Data fetching convention

- Server Components where static/SSR fits; client components + TanStack Query for interactive server state.
- Query keys scoped by organization: `['org', orgId, 'work-items', …]` (multi-tenant isolation mirrors API §11).
- Zod validates API responses at the boundary before data enters the UI.

---

## Phase 1 feature map (`phase-1.md` §8)

| UI area               | Route                           | Backend dependency       | `project.md` |
| --------------------- | ------------------------------- | ------------------------ | ------------ |
| App shell + auth      | `(auth)`, org switcher in shell | Wave 1 Identity          | §6, §9       |
| Integrations settings | `/integrations`                 | Wave 2 providers         | §8           |
| Developer dashboard   | `/dashboard`                    | Work Items API           | §9           |
| Work items            | `/work-items`                   | Work Items + Ticket AI   | §9           |
| PR review             | `/reviews`                      | Dev workflow + AI review | §9           |
| Activity timeline     | work-item detail (module)       | Activity API             | §9           |
| Realtime updates      | SSE client                      | Events + Redis pub/sub   | §12          |

Placeholder routes exist today; modules fill in as each wave’s API endpoints ship (`phase-1.md` §9).

---

## Scripts

From the monorepo root:

```bash
pnpm --filter @devflow/web dev          # Next.js dev (Turbopack)
pnpm --filter @devflow/web build
pnpm --filter @devflow/web start
pnpm --filter @devflow/web lint
pnpm --filter @devflow/web typecheck
pnpm --filter @devflow/web test           # Vitest
pnpm --filter @devflow/web test:e2e       # Playwright (starts dev server)
pnpm --filter @devflow/web clean
```

Or via Turborepo:

```bash
pnpm dev          # all apps with a dev script
pnpm lint
pnpm typecheck
pnpm test
```

---

## Environment variables

| Variable              | Required | Default                 | Purpose            |
| --------------------- | -------- | ----------------------- | ------------------ |
| `NEXT_PUBLIC_API_URL` | No       | `http://localhost:4000` | Devflow API origin |
| `PLAYWRIGHT_BASE_URL` | No       | `http://localhost:3000` | E2E base URL       |

Copy `.env.example` when added at repo root; never commit secrets.

---

## Testing

| Layer            | Tool                     | Location                    |
| ---------------- | ------------------------ | --------------------------- |
| Unit / component | Vitest + Testing Library | `**/*.{test,spec}.{ts,tsx}` |
| E2E              | Playwright               | `tests/e2e/`                |

E2E `webServer` runs `pnpm dev` locally; in CI set `CI=true` for retries and a fresh server.

---

## Linting & formatting

- **ESLint:** flat config via `@devflow/eslint-config/next` (Next.js core-web-vitals + TypeScript).
- **Prettier:** root `.prettierrc.json` — run `pnpm format` from monorepo root.
- **TypeScript:** `strict`, `noUncheckedIndexedAccess` from shared base config.

---

## What not to put here

Per architecture boundaries:

- Vendor SDKs (`@octokit/*`, `@slack/*`, etc.) — API adapters only (`project.md` §8, rule 1).
- Direct database or queue access — all persistence via `apps/api`.
- Merge/deploy automation without explicit user action — AI is assistant, not authority (§3, §11).

---

## Related documentation

- [`../../phase-1.md`](../../phase-1.md) — Wave 5 scope and build sequence
- [`../../project.md`](../../project.md) — full architecture
- [`../../tooling/README.md`](../../tooling/README.md) — shared ESLint/TS configs
