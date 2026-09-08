import { z } from 'zod';

/** Thrown when environment variables fail schema validation. */
export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment variables:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates a source (defaults to `process.env`) against a Zod schema and
 * returns the typed, parsed result. Throws `EnvValidationError` on failure so
 * the process fails fast at startup.
 */
export function createEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, unknown> = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new EnvValidationError(issues);
  }

  return result.data;
}
