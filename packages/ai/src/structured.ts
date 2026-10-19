import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AiValidationError } from './errors';
import type { AiMessage } from './provider';

/** Provider-neutral JSON Schema for a Zod schema (inlined, no `$ref`s, no `$schema` key). */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; problem: string };

export function parseStructured<S extends z.ZodTypeAny>(
  schema: S,
  raw: string,
): ParseOutcome<z.infer<S>> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, problem: 'The response was not valid JSON.' };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 20)
    .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  return { ok: false, problem: `The response did not match the required schema:\n${issues}` };
}

/** One attempt's raw text plus whatever the adapter wants to carry back to its caller. */
export interface StructuredAttempt<M> {
  text: string;
  meta: M;
}

/**
 * The structured-output failure semantics from the package README:
 * parse → validate → (at most one repair attempt, same capability/model) →
 * valid or `AiValidationError`, nothing in between.
 *
 * `call` is the adapter's single provider call; it must use the same resolved
 * model for both attempts. Provider errors from `call` propagate unchanged.
 */
export async function runStructured<S extends z.ZodTypeAny, M>(
  schema: S,
  messages: AiMessage[],
  call: (messages: AiMessage[]) => Promise<StructuredAttempt<M>>,
): Promise<{ value: z.infer<S>; attempts: StructuredAttempt<M>[] }> {
  const first = await call(messages);
  const firstOutcome = parseStructured(schema, first.text);
  if (firstOutcome.ok) return { value: firstOutcome.value, attempts: [first] };

  const repairMessages: AiMessage[] = [
    ...messages,
    { role: 'assistant', content: first.text },
    {
      role: 'user',
      content:
        `${firstOutcome.problem}\n\n` +
        'Return the corrected JSON only, matching the required schema exactly.',
    },
  ];
  const second = await call(repairMessages);
  const secondOutcome = parseStructured(schema, second.text);
  if (secondOutcome.ok) return { value: secondOutcome.value, attempts: [first, second] };

  throw new AiValidationError(
    `Structured output failed validation after one repair attempt. ${secondOutcome.problem}`,
  );
}
