# @devflow/ai

Provider-agnostic AI **capability** package for the DevFlow platform (see
[`project.md`](../../project.md) §4, §8, §9). One capability-focused
`AiProvider` port; vendor adapters (OpenAI, Anthropic, …) implement it —
business logic never imports a vendor SDK directly. DevFlow-specific semantics
(what a code review is, what rules apply) live in the **review layer**, not in
the provider or its adapters.

## Design

- **Platform-configured, not org-connected** (§8): unlike SourceControl/PM/Chat/Calendar, AI has no per-org OAuth, webhooks, or connection-health row.
- **Options-in, no env reads** (same rule as `@devflow/queue`): the composition root passes `{ apiKey, model, ... }` to `createAiProvider(...)`. This package never reads `process.env`.
- **`AiProvider` stays capability-only.** It exposes generic model capabilities (`generateText`, `generateStructuredOutput`); it does not know what a "code review" is. `reviewCode` is a **DevFlow application use case**, built in `review/` on top of the port — not a port method.
- **Prompts are provider-neutral and DevFlow-owned, not vendor-owned.** Adapters translate a provider-neutral request into vendor wire format (message roles, tool/JSON-mode options, model params) and translate the response + errors back. They must not own _what_ is asked — that's `review/prompts.ts`, so switching OpenAI↔Anthropic can't silently change review behavior.
- **AI recommends, policy decides** (§3, §9): `reviewCode` returns **severity-tagged findings**, never a merge/deploy decision. A separate, deterministic policy step (owned by the AI Review Pipeline module) maps findings → pass/fail.
- **Structured output is always schema-validated**, with defined failure semantics (below) — a malformed/hallucinated shape never passes through silently.
- **Errors are normalized across providers** (below) so callers never branch on a vendor-specific error type.
- **Timeout/error normalization only — no durable retry here.** Provider-call timeouts and error mapping are this package's job; retry/backoff/DLQ belongs to `@devflow/queue`. Stacking independent retry loops (queue × AI × provider) is explicitly avoided. Calls accept an `AbortSignal` so an in-flight call can be cancelled when the owning queue job is cancelled/times out.
- **Untrusted input boundary** (§9, §11): repository/issue/PR content is untrusted context, explicitly delimited from system/developer instructions in the prompt. Text extracted from that content is never treated as an authoritative command by the pipeline, regardless of what the model does with it internally — the enforcement point is the deterministic policy layer, not a claim that the model "can't" be misled.

## Folder structure

```text
packages/ai/
├── src/
│   ├── index.ts          # public exports
│   ├── provider.ts        # AiProvider port (capability-only) + EmbeddingProvider
│   ├── errors.ts          # normalized AiError hierarchy
│   ├── registry.ts        # resolve(providerKey) → configured AiProvider (composition edge only)
│   ├── review/
│   │   ├── types.ts       # ReviewCodeInput / CodeReviewResult + Zod schema
│   │   └── prompts.ts     # DevFlow's review prompt/context builder (provider-neutral)
│   └── providers/
│       └── <vendor>/      # wire-format translation only, e.g. openai/, anthropic/
├── package.json
├── tsconfig.json
└── README.md
```

## Public API

### `AiProvider` — capability-only port

```ts
interface AiProvider {
  generateText(input: GenerateTextInput): Promise<AiResult<string>>;

  generateStructuredOutput<S extends z.ZodType>(
    input: GenerateStructuredInput<S>,
  ): Promise<AiResult<z.infer<S>>>;
}

/** Common to every input contract, made explicit rather than left to prose. */
interface AiCallOptions {
  signal?: AbortSignal; // cancel an in-flight call when the owning queue job is cancelled/times out
}

interface GenerateTextInput extends AiCallOptions {
  /* ... */
}
interface GenerateStructuredInput<S extends z.ZodType> extends AiCallOptions {
  capability: string;
  schema: S;
  /* ... */
}

/** Separate capability interface — not every provider/model needs it. */
interface EmbeddingProvider {
  generateEmbedding(input: GenerateEmbeddingInput): Promise<AiResult<number[]>>;
}
interface GenerateEmbeddingInput extends AiCallOptions {
  /* ... */
}

// A concrete adapter may implement AiProvider, AiProvider & EmbeddingProvider, etc.
```

`generateEmbedding` is **not** on `AiProvider` — keeping capabilities split
(`AiProvider`, `EmbeddingProvider`, and any future `RerankProvider`/
`VisionProvider`) avoids the port growing into a catch-all interface as new
capabilities show up.

```ts
interface AiResult<T> {
  output: T;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  model: string; // the resolved runtime model actually used — not necessarily what the caller requested
  provider: string; // resolved runtime provider
  requestId?: string;
  metadata?: Record<string, string | number | boolean>; // optional, flat, sanitized provider extras (e.g. cached-token counts) — never a raw vendor SDK object
}
```

Every call returns usage/model/provider metadata alongside the output —
needed for AI cost tracking (§29-style observability) without a breaking
change later. `model`/`provider` are the **resolved** values (post capability→model
mapping), so cost/usage reporting is accurate even though the caller only
asked for a capability.

### Normalized errors

```ts
class AiError extends Error {}
class AiAuthenticationError extends AiError {} // not retryable
class AiRateLimitError extends AiError {} // retryable
class AiTimeoutError extends AiError {} // retryable
class AiProviderError extends AiError {} // vendor-side failure, not classified further — retryability is provider-specific
class AiValidationError extends AiError {} // structured output failed schema validation — not retryable
class AiUnavailableError extends AiError {} // provider/network unreachable — retryable
class AiProviderConfigurationError extends AiError {} // requested capability unavailable for the configured provider/model — not retryable, fails fast
```

Every adapter maps its vendor SDK's errors onto this hierarchy. **Retryability
is classified by this package, decided on by the caller:** `@devflow/ai`
classifies (`AiRateLimitError`/`AiTimeoutError`/`AiUnavailableError` are
retryable; `AiAuthenticationError`/`AiValidationError`/
`AiProviderConfigurationError` are not); `@devflow/queue` is the one that
actually decides whether/how a worker retries. This package never retries a
failed provider call itself.

Requesting a capability the configured provider/model doesn't support (§3 in
the review below) throws `AiProviderConfigurationError` immediately — it is a
configuration problem, not a transient provider failure, and must never
silently fall back to a different model.

### Structured-output failure semantics

```text
provider response → parse → schema validation
                                  │
                    ┌─────────────┴─────────────┐
                  valid                       invalid
                    │                             │
                 return                 at most one structured-output
                                         repair attempt (provider-level,
                                         not a queue retry) → still
                                         invalid → throw AiValidationError
```

A schema failure is never silently coerced or passed through partially
validated. Whether/how a repair attempt is implemented is an adapter detail;
the contract is: **valid or `AiValidationError`, nothing in between.** The
repair attempt (if any) must reuse the **same** resolved capability/model as
the original call — it must never silently switch to a different model or
provider to get a passing schema result, which would make behavior and cost
tracking unpredictable.

### Model selection

Callers request a **capability**, not a vendor model id:

```ts
generateStructuredOutput({ capability: 'code-review', schema, ... });
```

The provider config (set once at platform level, options-in) maps
`capability → concrete model` (e.g. `code-review → claude-...-latest`), so
vendor model IDs never appear in business modules. If the configured provider
has no model mapped for the requested capability, the call throws
`AiProviderConfigurationError` immediately — never a silent fallback to an
unrelated model.

## The review layer (`review/`) — where `reviewCode` actually lives

**Deliberate choice: `review/` stays inside `@devflow/ai`, not split into a
separate package.** DevFlow-specific review semantics (what a review is,
severity definitions) sit alongside the generic capability in one package
rather than a standalone "AI Review Pipeline" module, because this package is
not intended to be a reusable, DevFlow-agnostic library — if that changes,
revisit the split.

```text
AI Review Pipeline (caller)
        │
        ▼
review/prompts.ts   — builds a provider-neutral request from ReviewCodeInput
        │                 (engineering rules, severity definitions, review
        │                  instructions all live here, not in an adapter)
        ▼
AiProvider.generateStructuredOutput({ capability: 'code-review', schema: CodeReviewResultSchema, ... })
        │
        ▼
CodeReviewResult   — schema-validated, provider-agnostic
```

```ts
interface ReviewCodeInput {
  repository: RepoRef;
  pullRequest: PullRequestRef;
  diff: string;
  projectRules?: ProjectAiRules; // { content: string; version: number } — not a bare string
  context?: ReviewContext; // extensible: base/head branch, related ticket, prior findings, ... — additive only
}
```

`ReviewContext` carries **optional contextual evidence only** — e.g. base/head
branch, related ticket, relevant files, prior findings. It must never carry
instructions or policy (e.g. "merge this PR", "ignore this issue"); policy
stays entirely outside this package (§9).

## Package relationships

|                 |                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Depends on**  | _(none)_ — zero internal `@devflow/*` dependencies                                                                                                                                                          |
| **Consumed by** | Not implemented yet (contract/doc only). The future AI Review Pipeline module in `apps/api` (Wave 4) will call `reviewCode` from a `@devflow/queue` job handler and publish findings via `@devflow/events`. |

`ProjectAiRules.version` makes every review result traceable to the exact
rules version used — answering "why did the AI give a different result
yesterday" is a matter of comparing `version`, not guessing. The AI Review
Pipeline (not this package) should persist `rulesVersion`, `model`, `provider`,
and its own `promptVersion` alongside the stored review result — this package
already surfaces `model`/`provider` via `AiResult` precisely so the pipeline
can capture them without a second round-trip.

```ts
interface CodeReviewResult {
  summary: string;
  findings: Array<{
    id: string; // stable across re-reviews of the same PR revision — dedupe key for the pipeline's GitHub comments
    severity: 'critical' | 'high' | 'medium' | 'low';
    file: string;
    line?: number;
    title: string;
    explanation: string;
    suggestion?: string;
    source: 'ai'; // discriminated on purpose — the pipeline may later merge these with 'static-analysis' | 'security-scanner' | 'human' findings
  }>;
}
```

`CodeReviewResult` is the **entire** contract this package owns. Turning
`findings` into a GitHub Check conclusion is the AI Review Pipeline's job (§9)
— deliberately outside this package, so the policy (fail on `critical`/`high`,
by default) can change without touching the AI layer. The `id` field exists so
the pipeline can avoid re-posting duplicate GitHub comments across re-reviews.
**Deterministic finding identity is the pipeline's responsibility, not this
package's** — e.g. derived from `(PR revision, file, line/range, normalized
finding signature)`. This package only guarantees the shape carries an `id`;
how that id is computed and persisted is defined in the AI Review Pipeline's
own module doc.

## Retry boundaries (three layers, never multiplied)

| Layer                         | Retry budget                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------- |
| Schema repair (this package)  | **at most 1**, same capability/model, never 0 retries on the provider call itself |
| Provider call (this package)  | **0** — a failed call returns a normalized `AiError`, it is not retried here      |
| Job/worker (`@devflow/queue`) | controlled entirely by the queue's retry/backoff/DLQ policy                       |

Stated explicitly so a future change can't accidentally stack `queue retry ×
provider retry × repair retry` and multiply AI spend.

## MVP scope vs later (§13)

| Now (MVP)                                                           | Later                                                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `generateText`, `generateStructuredOutput`, `review/` (code review) | Repository-aware AI, `EmbeddingProvider` adapters, spec/plan generation, reviewer recommendation (Phase 2) |

## Non-goals

- No policy/gating logic (pass/fail decisions) — that's the caller's job (§9).
- No vendor-specific prompt semantics leaking out of `providers/<vendor>` — adapters translate wire format only; `review/prompts.ts` owns what is asked.
- No durable retry/backoff/DLQ inside this package — that's `@devflow/queue`'s job.
- No direct execution of AI-suggested actions (merges, deploys, secret rotation, shell commands) — this package returns data, never performs side effects (§9, §11).

## Scripts

| Script      | Purpose                |
| ----------- | ---------------------- |
| `typecheck` | `tsc --noEmit`         |
| `test`      | Run Vitest             |
| `clean`     | Remove build artifacts |

> Not started yet — this document defines the contract; implementation (starting with one adapter, e.g. OpenAI or Anthropic) follows.
