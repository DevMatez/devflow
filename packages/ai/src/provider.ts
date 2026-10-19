import type { z } from 'zod';

/**
 * Capabilities a caller can request. Callers ask for a capability, never a
 * vendor model id — the provider config maps capability → concrete model.
 */
export const AI_CAPABILITIES = ['code-review', 'ticket-draft'] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

/** Common to every input contract. */
export interface AiCallOptions {
  /** Cancel an in-flight call when the owning queue job is cancelled/times out. */
  signal?: AbortSignal;
}

/**
 * Provider-neutral message. `role` is the conversational role only; system
 * instructions go in `instructions`, never in a message.
 */
export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateTextInput extends AiCallOptions {
  capability: AiCapability;
  /** Trusted, DevFlow-owned instructions (rendered as the system prompt). */
  instructions: string;
  messages: AiMessage[];
  maxOutputTokens?: number;
}

export interface GenerateStructuredInput<S extends z.ZodTypeAny> extends GenerateTextInput {
  schema: S;
  /** Short identifier for the schema, used by vendors that name output formats/tools. */
  schemaName: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiResult<T> {
  output: T;
  usage?: AiUsage;
  /** The resolved runtime model actually used — not necessarily what the caller requested. */
  model: string;
  /** Resolved runtime provider. */
  provider: string;
  requestId?: string;
  /** Optional, flat, sanitized provider extras — never a raw vendor SDK object. */
  metadata?: Record<string, string | number | boolean>;
}

/** Capability-only port. Knows nothing about code review — see `review/`. */
export interface AiProvider {
  readonly name: string;

  generateText(input: GenerateTextInput): Promise<AiResult<string>>;

  generateStructuredOutput<S extends z.ZodTypeAny>(
    input: GenerateStructuredInput<S>,
  ): Promise<AiResult<z.infer<S>>>;
}

export interface GenerateEmbeddingInput extends AiCallOptions {
  text: string;
}

/** Separate capability interface — not every provider/model needs it. No adapter implements it yet. */
export interface EmbeddingProvider {
  generateEmbedding(input: GenerateEmbeddingInput): Promise<AiResult<number[]>>;
}
