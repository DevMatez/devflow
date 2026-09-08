import { describe, expect, it } from 'vitest';
import { z, createEnv, EnvValidationError, sharedEnv } from '../index';

describe('createEnv', () => {
  const schema = z.object({
    NODE_ENV: sharedEnv.nodeEnv(),
    PORT: sharedEnv.port(4000),
  });

  it('parses and coerces a valid source', () => {
    const env = createEnv(schema, { NODE_ENV: 'production', PORT: '8080' });

    expect(env.NODE_ENV).toBe('production');
    expect(env.PORT).toBe(8080);
  });

  it('applies defaults when values are missing', () => {
    const env = createEnv(schema, {});

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
  });

  it('throws EnvValidationError with the offending path on invalid input', () => {
    expect(() => createEnv(schema, { PORT: 'not-a-number' })).toThrow(EnvValidationError);

    try {
      createEnv(schema, { PORT: 'not-a-number' });
    } catch (error) {
      expect((error as EnvValidationError).issues.join()).toContain('PORT');
    }
  });
});
