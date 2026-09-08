# Feature modules

Business logic and UI for a product area live here — not in generic `components/ui`.

Each module owns hooks, queries, forms, and feature-specific components. Routes in `app/` compose module exports.

| Module           | Phase 1 scope (`phase-1.md` §8)       |
| ---------------- | ------------------------------------- |
| `dashboard/`     | Developer dashboard — My Work (§9)    |
| `work-items/`    | List, detail, create, start work (§9) |
| `projects/`      | Projects and workflow config (§9)     |
| `reviews/`       | PR review experience (§9)             |
| `integrations/`  | Connect providers (§8)                |
| `activity/`      | Activity timeline UI (§9)             |
| `notifications/` | In-app notification surfaces          |
