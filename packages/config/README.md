# @devflow/config

Typed environment loading and runtime configuration for the DevFlow monorepo
(see [`project.md`](../../project.md) §6). Every app validates its config the
same way and shares one Zod instance.

## What it provides

| Export                       | Purpose                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `createEnv(schema, source?)` | Validate a source (defaults to `process.env`) → typed result; throws on failure        |
| `EnvValidationError`         | Error carrying the list of offending variables                                         |
| `sharedEnv`                  | Reusable env fragments: `nodeEnv`, `logLevel`, `host`, `port`, `requiredString`, `url` |
| `z`                          | Re-exported Zod, so every consumer builds schemas with the same instance               |

## Usage

```ts
import 'dotenv/config';
import { z, createEnv, sharedEnv } from '@devflow/config';

const env = createEnv(
  z.object({
    NODE_ENV: sharedEnv.nodeEnv(),
    HOST: sharedEnv.host(),
    PORT: sharedEnv.port(4000),
    LOG_LEVEL: sharedEnv.logLevel(),
    DATABASE_URL: sharedEnv.requiredString(),
  }),
);

export type Env = typeof env;
```

- Loading `.env` files is the **app's** responsibility (`import 'dotenv/config'`), not this package's — it stays side-effect free.
- `createEnv` **throws** on invalid config so the process fails fast at startup.

## Package relationships

|                 |                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| **Depends on**  | _(none)_ — zero internal `@devflow/*` dependencies                                                          |
| **Consumed by** | `apps/api` (env schema, see [`apps/api/README.md`](../../apps/api/README.md)); `apps/worker` once it exists |

## Scripts

| Script      | Purpose                |
| ----------- | ---------------------- |
| `typecheck` | `tsc --noEmit`         |
| `test`      | Run Vitest             |
| `clean`     | Remove build artifacts |
