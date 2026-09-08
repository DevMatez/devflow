# API Docs & Testing Conventions

How to keep the OpenAPI/Scalar documentation and the test suite consistent as new
routes and modules are added to `@devflow/api`.

---

## 1. API documentation

Docs are generated from code — there is no hand-written spec to keep in sync.

- **Source of truth:** the Zod `schema` on each route (`routes/v<n>/<module>/schema.ts`)
  plus the route's `schema` metadata (`tags`, `summary`, `description`, `response`).
- **Spec generator:** `@fastify/swagger` + `jsonSchemaTransform` (see `src/plugins/openapi.ts`).
- **UI:** Scalar, served at **`/doc`**.
- **Raw spec:** **`/openapi.json`**.

### Every route MUST declare

| Field         | Rule                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `tags`        | Exactly one tag, matching a tag defined in `src/plugins/openapi.ts`.                               |
| `summary`     | Short imperative phrase (e.g. "Create a work item").                                               |
| `description` | 1–2 sentences: what it does, key inputs/outputs, side effects.                                     |
| `response`    | A Zod schema for each status code returned (`200`/`201` for sync success, `202` for async/outbox). |

### Schema field descriptions

Annotate non-obvious fields with `.describe(...)` so they render in Scalar:

```ts
export const example = z.object({
  status: z.literal('ok').describe('Service health status.'),
  uptime: z.number().describe('Process uptime in seconds.'),
});
```

### Adding a tag

New module → add its tag (with a `description`) to the `tags` array in
`src/plugins/openapi.ts` before using it on routes. Keep tag names singular and
capitalized (`Health`, `WorkItem`, `PullRequest`).

---

## 2. Testing conventions

- **Runner:** Vitest. Pattern: `src/**/*.test.ts`.
- **Style:** integration-first — build the real app with `buildApp()` and use
  `app.inject()` (no network). This exercises routing, validation, and serialization.
- **Location:**
  - Feature tests → the module's `__tests__/` folder.
  - App-wide behavior (404s, docs, plugins) → `src/__tests__/`.

### Minimal & critical coverage (current)

| Test                                    | Why it's critical                                    |
| --------------------------------------- | ---------------------------------------------------- |
| `GET /api/v1/health` → 200 + body shape | Core liveness contract; validates response schema.   |
| Unknown route → 404                     | Confirms routing/prefixing behaves as expected.      |
| `GET /openapi.json` → paths + tags      | Guards that documentation generation stays wired up. |

### What "critical" means here

Keep the suite small but protect the contracts that break silently:

1. **Status codes** for the happy path and the most likely failure.
2. **Response shape** matches the declared schema (types, required fields).
3. **Validation** rejects bad input (once routes take input) with `400`.
4. **Docs wiring** — the spec still lists the route.

Add heavier domain/unit tests (service + dal) as those layers gain real logic.

### Checklist when adding a route

- [ ] Route declares `tags`, `summary`, `description`, and `response` schema.
- [ ] New tag (if any) registered in `src/plugins/openapi.ts`.
- [ ] Happy-path test (status + body shape).
- [ ] Failure-path test (validation `400` / not-found `404`) where applicable.
- [ ] `pnpm --filter @devflow/api typecheck && test && build` all pass.
