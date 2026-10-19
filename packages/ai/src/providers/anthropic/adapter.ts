import Anthropic from '@anthropic-ai/sdk';
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import type { z } from 'zod';
import {
  AiAuthenticationError,
  AiError,
  AiProviderConfigurationError,
  AiProviderError,
  AiRateLimitError,
  AiTimeoutError,
  AiUnavailableError,
  AiValidationError,
} from '../../errors';
import type {
  AiCapability,
  AiMessage,
  AiProvider,
  AiResult,
  AiUsage,
  GenerateStructuredInput,
  GenerateTextInput,
} from '../../provider';
import { runStructured, toJsonSchema } from '../../structured';

export const ANTHROPIC_PROVIDER = 'anthropic';

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicCapabilityConfig {
  model: string;
  effort?: AnthropicEffort;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  /** capability → model (+ effort). An unmapped capability throws `AiProviderConfigurationError`. */
  capabilities: Partial<Record<AiCapability, AnthropicCapabilityConfig>>;
  /** Per-call timeout. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Default `max_tokens` when the caller doesn't pass `maxOutputTokens`. */
  defaultMaxOutputTokens?: number;
  baseURL?: string;
  /** Injected client (tests). When set, `apiKey`/`baseURL`/`timeoutMs` are ignored. */
  client?: Anthropic;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

interface CallMeta {
  usage: AiUsage;
  model: string;
  requestId?: string;
  stopReason: string | null;
}

/**
 * Anthropic (Claude) adapter. Wire-format translation and error mapping only:
 * what is asked lives in the caller (`review/prompts.ts`, ticket-ai), never here.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): AiProvider {
  const client =
    options.client ??
    new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Retry budget at this layer is 0 — the queue owns retries (README "Retry boundaries").
      maxRetries: 0,
    });
  const defaultMaxTokens = options.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  function resolve(capability: AiCapability): AnthropicCapabilityConfig {
    const config = options.capabilities[capability];
    if (!config) {
      throw new AiProviderConfigurationError(
        `No Anthropic model configured for capability "${capability}"`,
      );
    }
    return config;
  }

  async function call(
    input: GenerateTextInput,
    config: AnthropicCapabilityConfig,
    messages: AiMessage[],
    format?: Record<string, unknown>,
  ): Promise<{ text: string; meta: CallMeta }> {
    let response: Anthropic.Message;
    let requestId: string | null | undefined;
    try {
      ({ data: response, request_id: requestId } = await client.messages
        .create(
          {
            model: config.model,
            max_tokens: input.maxOutputTokens ?? defaultMaxTokens,
            system: input.instructions,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            ...(config.effort || format
              ? {
                  output_config: {
                    ...(config.effort ? { effort: config.effort } : {}),
                    ...(format ? { format: { type: 'json_schema' as const, schema: format } } : {}),
                  },
                }
              : {}),
          },
          { signal: input.signal },
        )
        .withResponse());
    } catch (error) {
      throw mapAnthropicError(error);
    }

    if (response.stop_reason === 'refusal') {
      throw new AiProviderError('The model declined the request (stop_reason: refusal)', {
        retryable: false,
      });
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const usage: AiUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };
    return {
      text,
      meta: {
        usage,
        model: response.model,
        requestId: requestId ?? undefined,
        stopReason: response.stop_reason,
      },
    };
  }

  return {
    name: ANTHROPIC_PROVIDER,

    async generateText(input: GenerateTextInput): Promise<AiResult<string>> {
      const config = resolve(input.capability);
      const { text, meta } = await call(input, config, input.messages);
      return toResult(text, [meta]);
    },

    async generateStructuredOutput<S extends z.ZodTypeAny>(
      input: GenerateStructuredInput<S>,
    ): Promise<AiResult<z.infer<S>>> {
      const config = resolve(input.capability);
      const format = transformJSONSchema(toJsonSchema(input.schema));
      const { value, attempts } = await runStructured(
        input.schema,
        input.messages,
        async (msgs) => {
          const attempt = await call(input, config, msgs, format);
          if (attempt.meta.stopReason === 'max_tokens') {
            // Truncated JSON: a repair attempt at the same budget would truncate again.
            throw new AiValidationError(
              'Structured output was truncated (stop_reason: max_tokens); raise maxOutputTokens',
            );
          }
          return attempt;
        },
      );
      return toResult(
        value,
        attempts.map((a) => a.meta),
      );
    },
  };
}

function toResult<T>(output: T, metas: CallMeta[]): AiResult<T> {
  const last = metas[metas.length - 1]!;
  const usage = metas.reduce<AiUsage>(
    (acc, m) => ({
      inputTokens: acc.inputTokens + m.usage.inputTokens,
      outputTokens: acc.outputTokens + m.usage.outputTokens,
      totalTokens: acc.totalTokens + m.usage.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  return {
    output,
    usage,
    model: last.model,
    provider: ANTHROPIC_PROVIDER,
    requestId: last.requestId,
    metadata: { attempts: metas.length },
  };
}

/** Map an Anthropic SDK error onto the normalized hierarchy. Most specific first. */
export function mapAnthropicError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof Anthropic.APIUserAbortError) {
    return new AiError('AI call aborted by caller', { cause: error });
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiTimeoutError('Anthropic request timed out', { cause: error });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiUnavailableError('Anthropic API unreachable', { cause: error });
  }
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new AiAuthenticationError(`Anthropic rejected credentials: ${error.message}`, {
      cause: error,
    });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiRateLimitError('Anthropic rate limit exceeded', { cause: error });
  }
  if (error instanceof Anthropic.NotFoundError) {
    // Almost always an unknown model id — a configuration problem, not transient.
    return new AiProviderConfigurationError(`Anthropic resource not found: ${error.message}`, {
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    if (status === 529) {
      return new AiUnavailableError('Anthropic API overloaded', { cause: error });
    }
    if (status === 408) {
      return new AiTimeoutError('Anthropic request timed out', { cause: error });
    }
    return new AiProviderError(`Anthropic API error ${status}: ${error.message}`, {
      cause: error,
      retryable: status >= 500,
    });
  }
  return new AiProviderError(
    `Unexpected Anthropic adapter error: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}
