import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AiAuthenticationError,
  AiProviderConfigurationError,
  AiProviderError,
  AiRateLimitError,
  AiTimeoutError,
  AiUnavailableError,
  AiValidationError,
} from '../errors';
import { createAnthropicProvider, mapAnthropicError } from '../providers/anthropic/adapter';

function message(text: string, overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-test-resolved',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  } as Anthropic.Message;
}

/** A fake client whose `messages.create` replays queued responses (or throws queued errors). */
function fakeClient(responses: Array<Anthropic.Message | Error>) {
  const create = vi.fn<
    (body: Anthropic.MessageCreateParamsNonStreaming, opts?: unknown) => unknown
  >(() => {
    const next = responses.shift();
    return {
      withResponse: async () => {
        if (!next) throw new Error('no more fake responses');
        if (next instanceof Error) throw next;
        return { data: next, request_id: 'req_1' };
      },
    };
  });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

const capabilities = {
  'code-review': { model: 'claude-test', effort: 'high' as const },
  'ticket-draft': { model: 'claude-test' },
};

const schema = z.object({ answer: z.number() });

describe('anthropic adapter — generateText', () => {
  it('returns AiResult with resolved model, provider, usage and request id', async () => {
    const { client, create } = fakeClient([message('hello')]);
    const provider = createAnthropicProvider({ apiKey: 'k', capabilities, client });

    const result = await provider.generateText({
      capability: 'code-review',
      instructions: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result).toMatchObject({
      output: 'hello',
      model: 'claude-test-resolved',
      provider: 'anthropic',
      requestId: 'req_1',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    const body = create.mock.calls[0]![0];
    expect(body.model).toBe('claude-test');
    expect(body.system).toBe('be brief');
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('throws AiProviderConfigurationError for an unmapped capability, without calling the API', async () => {
    const { client, create } = fakeClient([]);
    const provider = createAnthropicProvider({ apiKey: 'k', capabilities: {}, client });
    await expect(
      provider.generateText({ capability: 'code-review', instructions: '', messages: [] }),
    ).rejects.toBeInstanceOf(AiProviderConfigurationError);
    expect(create).not.toHaveBeenCalled();
  });

  it('maps a refusal stop reason to a non-retryable AiProviderError', async () => {
    const { client } = fakeClient([message('', { stop_reason: 'refusal' })]);
    const provider = createAnthropicProvider({ apiKey: 'k', capabilities, client });
    const err = await provider
      .generateText({ capability: 'ticket-draft', instructions: '', messages: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).retryable).toBe(false);
  });
});

describe('anthropic adapter — generateStructuredOutput', () => {
  const input = {
    capability: 'ticket-draft' as const,
    schema,
    schemaName: 'answer',
    instructions: 'answer',
    messages: [{ role: 'user' as const, content: 'q' }],
  };

  it('returns schema-validated output and sends a json_schema format', async () => {
    const { client, create } = fakeClient([message('{"answer":42}')]);
    const provider = createAnthropicProvider({ apiKey: 'k', capabilities, client });

    const result = await provider.generateStructuredOutput(input);

    expect(result.output).toEqual({ answer: 42 });
    const format = create.mock.calls[0]![0].output_config?.format;
    expect(format?.type).toBe('json_schema');
    expect(format?.schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('repairs once on invalid output, with the same model, and sums usage', async () => {
    const { client, create } = fakeClient([message('{"answer":"nope"}'), message('{"answer":7}')]);
    const provider = createAnthropicProvider({ apiKey: 'k', capabilities, client });

    const result = await provider.generateStructuredOutput(input);

    expect(result.output).toEqual({ answer: 7 });
    expect(create).toHaveBeenCalledTimes(2);
    const [first, second] = create.mock.calls.map((c) => c[0]);
    expect(second!.model).toBe(first!.model);
    expect(second!.messages).toHaveLength(3);
    expect(second!.messages.at(-1)!.role).toBe('user');
    expect(result.usage?.totalTokens).toBe(30);
    expect(result.metadata?.attempts).toBe(2);
  });

  it('throws AiValidationError when the repair attempt is still invalid (no third call)', async () => {
    const { client, create } = fakeClient([message('not json'), message('{"answer":null}')]);
    const provider = createAnthropicProvider({ apiKey: 'k', capabilities, client });

    await expect(provider.generateStructuredOutput(input)).rejects.toBeInstanceOf(
      AiValidationError,
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('treats truncated output (max_tokens) as AiValidationError without a repair call', async () => {
    const { client, create } = fakeClient([message('{"ans', { stop_reason: 'max_tokens' })]);
    const provider = createAnthropicProvider({ apiKey: 'k', capabilities, client });

    await expect(provider.generateStructuredOutput(input)).rejects.toBeInstanceOf(
      AiValidationError,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('propagates provider errors from the call as normalized errors', async () => {
    const { client } = fakeClient([
      Anthropic.APIError.generate(429, { type: 'error' }, 'slow down', new Headers()),
    ]);
    const provider = createAnthropicProvider({ apiKey: 'k', capabilities, client });
    await expect(provider.generateStructuredOutput(input)).rejects.toBeInstanceOf(AiRateLimitError);
  });
});

describe('mapAnthropicError', () => {
  const gen = (status: number) =>
    Anthropic.APIError.generate(status, { type: 'error' }, 'x', new Headers());

  it.each([
    [401, AiAuthenticationError, false],
    [403, AiAuthenticationError, false],
    [404, AiProviderConfigurationError, false],
    [429, AiRateLimitError, true],
    [529, AiUnavailableError, true],
    [500, AiProviderError, true],
    [400, AiProviderError, false],
  ])('status %i → %o (retryable: %s)', (status, cls, retryable) => {
    const mapped = mapAnthropicError(gen(status));
    expect(mapped).toBeInstanceOf(cls);
    expect(mapped.retryable).toBe(retryable);
  });

  it('maps connection timeouts and connection errors', () => {
    expect(mapAnthropicError(new Anthropic.APIConnectionTimeoutError())).toBeInstanceOf(
      AiTimeoutError,
    );
    expect(mapAnthropicError(new Anthropic.APIConnectionError({ message: 'down' }))).toBeInstanceOf(
      AiUnavailableError,
    );
  });
});
