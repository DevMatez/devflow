# @devflow/validation

Shared **runtime validation** (Zod schemas) for the DevFlow monorepo (see
[`project.md`](../../project.md) §6). Used at every trust boundary — API
requests, webhook payloads, and forms.

## Contents

| Module       | Exports                                                                             |
| ------------ | ----------------------------------------------------------------------------------- |
| `enums`      | `roleSchema`, `workItemStatusSchema`, `prioritySchema`, `integrationCategorySchema` |
| `primitives` | `uuidSchema`, `emailSchema`, `slugSchema`                                           |
| (root)       | re-exported `z` so consumers share one Zod instance                                 |

## Relationship to `@devflow/types`

`@devflow/types` owns the canonical enum **arrays**; this package turns them into
Zod schemas. Compile-time types and runtime validation stay in lock-step because
both derive from the same source.

```ts
import { roleSchema } from '@devflow/validation';
import type { Role } from '@devflow/types';

const role: Role = roleSchema.parse(input); // validated + typed
```

## Package relationships

|                 |                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Depends on**  | `@devflow/types` (enum arrays)                                                                                                               |
| **Consumed by** | Not yet imported by an app — domain modules (Wave 1+) will use these schemas for request/response validation at HTTP and webhook boundaries. |

## Scripts

| Script      | Purpose                |
| ----------- | ---------------------- |
| `typecheck` | `tsc --noEmit`         |
| `test`      | Run Vitest             |
| `clean`     | Remove build artifacts |
