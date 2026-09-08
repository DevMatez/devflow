# devflow

Developer workflow orchestration platform — see [`project.md`](./project.md) for the
architecture and [`phase-1.md`](./phase-1.md) for the MVP build plan.

**Onboarding — start here, in order:**

1. [`project.md`](./project.md) — product, architecture, core domains.
2. [`packages/README.md`](./packages/README.md) — shared packages and how they depend on each other.
3. [`apps/api/docs/orchestration.md`](./apps/api/docs/orchestration.md) — how `apps/api` wires the foundation packages together at runtime (boot sequence, correlation ids, the outbox → relay → queue → worker pipeline).
4. Each app/package's own `README.md` for its specific contract and usage.
